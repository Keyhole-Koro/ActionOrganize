# Discord Integration Implementation Ticket

この文書は、Discord Bot を workspace 単位で接続し、Discord 上の会話を live で取り込みつつ `ActionOrganize` / `ActionAct` から再利用できる形へ整理するための実装チケットを定義する。

対象は次の 3 層である。

* live Discord bot 実行基盤
* workspace と Discord guild の紐付け
* ingest / organize / act からの再利用導線

## 実装前提

現在のコードベースには次が存在する。

* `ActionOrganize/discord-bot` に `discord.py` ベースの live bot 実装がある
* bot は `on_message` で guild message を受け取り、GCS に `discord/{workspace_id}/{container_id}/{message_id}.json` を保存する
* bot は `discord.message.received` event を Pub/Sub publish できる
* `ActionOrganize/src/agents/handlers/pipeline-handlers.ts` には `DiscordMessageReceivedHandler` があり、`DiscordNodeService` を呼べる
* `ActionAct/act-adk-worker` には GCS / Firestore 上の Discord ログを読む `DiscordStore` がある

一方で、次は未完成または未整備である。

* Terraform に `discord-bot` 実行基盤がない
* Terraform に `discord.message.received` 用 subscription がない
* bot token の secret 注入が IaC 管理されていない
* workspace がどの guild を読むべきかの正本がない
* frontend に bot 招待 / 接続導線がない
* `DISCORD_GUILD_IDS` を runtime config ではなく固定 env に置く前提が残っている

この前提から、以下を方針として固定する。

* `DISCORD_BOT_TOKEN` は GitHub Actions secret から Secret Manager へ同期し、runtime は Secret Manager 注入で受ける
* `DISCORD_GUILD_IDS` は環境変数固定を廃止し、workspace integration 設定を正本とする
* guild と workspace の対応は Firestore に保存する
* bot は `guild_id -> workspace_id` lookup を毎回行い、workspace 固定 env を前提にしない
* bot の publish 先 Pub/Sub topic は既存 `mind-events` に統一する
* `discord.message.received` は既存 organize event bus に乗せる

## 目的

* Discord bot を live で常駐させ、参加 guild の会話を Action の knowledge graph に取り込めるようにする
* workspace ごとに接続先 guild を明示的に管理できるようにする
* bot 招待から接続完了までの導線をユーザーに提供する
* 保存済み Discord ログを organize / act の両方で再利用できるようにする

## 実装順

1. T1 Terraform / Runtime Infra
2. T2 Workspace Integration Schema
3. T3 Bot Runtime Lookup
4. T4 Frontend Connect Flow
5. T4.5 Semi-Automatic Install Confirmation
6. T5 CI/CD Secret Flow
7. T6 Docs / Rollout

この順を固定する理由:

* 実行基盤と Pub/Sub 配線がないと bot を本番で回せない
* workspace-guild mapping を先に決めないと bot runtime と UI の責務がぶれる
* 招待導線は backend / schema が固まってから実装した方が手戻りが少ない
* 完全自動確定より、session + candidate + user confirm 1 回の半自動確定の方が Discord 側仕様に依存しすぎず安定する

## T1. Terraform / Runtime Infra

目的:

* `discord-bot` を GCP 上で常駐実行できるようにする

対象:

* `terraform/infrastructure/services.tf`
* `terraform/infrastructure/messaging.tf`
* `terraform/infrastructure/iam.tf`
* 必要なら `terraform/infrastructure/variables.tf`

作業内容:

* `discord-bot` 用 service account を追加する
* `discord-bot` 用実行基盤を追加する
  * 第一候補は GCE VM または instance template + MIG
* bot に必要な権限を付与する
  * GCS object write
  * Pub/Sub publish
  * Secret Manager access
  * 必要なら logging write
* Pub/Sub `mind-events` に対し `discord.message.received` を organize へ push する subscription を追加する
* `discord-bot` の publish topic を `mind-events` に揃える

設計メモ:

* `discord-bot` は WebSocket 常駐なので Cloud Run より GCE 常駐の方が扱いやすい
* 現在の bot 実装は flush ではなく `on_message -> GCS JSON -> Pub/Sub` なので、その実装を正として IaC を揃える
* 追加 topic を増やすより、既存 `mind-events` へ event type で流す方が既存 organize 設計に馴染む

DoD:

* `discord-bot` が GCP 上で起動できる
* `discord.message.received` が `mind-events` に publish される
* organize が `discord.message.received` を受けられる

依存:

* なし

## T2. Workspace Integration Schema

目的:

* workspace と Discord guild の対応関係を正本化する

対象:

* Firestore schema docs
* frontend / backend integration read path
* bot runtime lookup path

作業内容:

* `workspaces/{workspaceId}/integrations/discord` を追加する
* 少なくとも次の field を持つ
  * `enabled: boolean`
  * `guildId: string`
  * `guildName: string`
  * `installedBy: string`
  * `installedAt`
  * `botJoined: boolean`
  * `status: "pending" | "active" | "error"`
* guild から workspace を引ける lookup を設計する
  * 例: `discord_guild_bindings/{guildId}`
* `DISCORD_GUILD_IDS` env 固定前提を廃止する

設計メモ:

* `1 workspace = 1 guild` を初期制約として固定してよい
* multi-guild 対応は後回しにする
* bot runtime が軽く lookup できるよう、guild 起点の document を別途持つ方が安全

DoD:

* workspace がどの guild と接続しているか Firestore で一意に分かる
* bot runtime が `guild_id -> workspace_id` を引ける
* env の `DISCORD_GUILD_IDS` に依存しない

依存:

* T1

## T3. Bot Runtime Lookup

目的:

* bot が message ごとに正しい workspace を判定できるようにする

対象:

* `ActionOrganize/discord-bot/src/main.py`
* `ActionOrganize/discord-bot/src/gcs_store.py`
* 必要なら lookup helper

作業内容:

* `WORKSPACE_ID` 固定 env をやめる
* `on_message` で受けた `guild.id` から workspace binding を lookup する
* binding がない guild は ignore する
* GCS path / Pub/Sub payload の `workspace_id` は lookup 結果を使う
* message ingest のログに `workspaceId`, `guildId`, `channelId`, `threadId` を残す

設計メモ:

* 未接続 guild の message は黙って捨てるのではなく、debug log は残してよい
* bot 参加後、workspace binding がまだ無い期間を `pending` として扱えると運用しやすい

DoD:

* bot が guild ごとに異なる workspace へ書き分けられる
* `WORKSPACE_ID` 固定なしで live ingest できる

依存:

* T2

## T4. Frontend Connect Flow

目的:

* ユーザーが workspace から Discord bot を接続できる導線を用意する

対象:

* workspace settings UI
* invite URL 生成 endpoint
* install completion flow

作業内容:

* workspace settings に `Connect Discord` 導線を追加する
* Discord OAuth2 bot invite URL を生成する
* ユーザーが guild を選んで bot を招待できるようにする
* 初期版では invite URL を開いたあと、接続状態と candidate guild を見られるようにする
* 現在の接続状態を UI で見えるようにする
  * `Not connected`
  * `Pending`
  * `Active`
  * `Error`

設計メモ:

* 初期版では slash command は不要
* 完全自動 callback 確定は初期版の必須にしない
* 重要なのは invite 完了後に `guildId -> workspaceId` binding が安全に確定すること

DoD:

* workspace から bot 招待を開始できる
* 接続済み guild が UI で確認できる
* pending install を UI で確認できる

依存:

* T2

## T4.5 Semi-Automatic Install Confirmation

目的:

* `guildId` 手入力をやめ、bot 招待後の guild 候補を UI で 1 回確認するだけで binding を確定できるようにする

対象:

* Firestore install session schema
* `act-api` install session endpoints
* `ActionOrganize/discord-bot` の guild join hook
* frontend `Connect Discord` dialog

作業内容:

* `discord_install_sessions/{sessionId}` を追加する
* 少なくとも次の field を持つ
  * `workspaceId`
  * `requestedBy`
  * `status: "pending" | "awaiting_confirmation" | "completed" | "expired"`
  * `selectedGuildId`
  * `createdAt`
  * `updatedAt`
  * `expiresAt`
* `discord_install_sessions/{sessionId}/candidates/{guildId}` を追加する
  * `guildId`
  * `guildName`
  * `joinedAt`
  * `source: "guild_join"`
* `act-api` に次を追加する
  * install session 作成 endpoint
  * install session 読み出し endpoint
  * candidate guild 確定 endpoint
* invite 開始時に install session を作り、UI はその session を購読または polling する
* bot 側は `on_guild_join` で guild candidate を記録する
* frontend は candidate 一覧を表示し、ユーザーが 1 回選択して confirm できるようにする
* confirm 時に transaction で次を同時更新する
  * `workspaces/{workspaceId}/integrations/discord`
  * `discord_guild_bindings/{guildId}`
  * `discord_install_sessions/{sessionId}`

設計メモ:

* Discord の bot invite は callback 情報だけで最終 guild を安全に確定できるとは限らない
* そのため初期版は `state` を補助的に扱っても、確定は candidate 選択 1 回を残す
* candidate の source は初期版では `on_guild_join` のみとし、`on_ready` の既存 guild 一覧は混ぜない
* pending session には TTL を持たせ、古い session を誤って使わないようにする
* `1 guild = 1 workspace` 制約は confirm transaction 時に厳格に検証する

DoD:

* user は `guildId` を手入力せずに接続できる
* install session ごとに guild candidate が見える
* confirm は transaction で一貫して反映される
* 既存 binding がある guild を誤って別 workspace に結び付けない

依存:

* T2
* T3
* T4

## T5. CI/CD Secret Flow

目的:

* Discord bot token を GitHub Actions secret 起点で安全に本番へ反映する

対象:

* GitHub Actions workflows
* Terraform secret resources
* deploy docs

作業内容:

* GitHub Actions secret `DISCORD_BOT_TOKEN` を Secret Manager へ同期する step を追加する
* runtime は Secret Manager から token を読むようにする
* bot token rotation 手順を docs に追加する
* `DISCORD_GUILD_IDS` は GHA secret 管理対象から外す

設計メモ:

* GHA secret は deploy-time source であり runtime source ではない
* runtime が直接 GHA secret を読める前提は置かない

DoD:

* bot token が GHA secret から Secret Manager へ反映される
* runtime は Secret Manager 注入で起動できる
* guild list は secret ではなく Firestore integration が正本になる

依存:

* T1

## T6. Docs / Rollout

目的:

* 運用者と利用者の両方が Discord integration の構成を理解できるようにする

対象:

* `ActionOrganize/discord-bot/README.md`
* `docs/security.md`
* 必要なら `docs/overview.md`

作業内容:

* `discord-bot` README を現行コードに合わせて更新する
  * flush / Markdown 前提の記述を削除
  * `on_message -> GCS JSON -> mind-events -> organize` に更新
* workspace-guild binding の運用手順を追記する
* bot token の secret 管理方針を追記する
* user 向けには `Connect Discord` の説明を追加する

DoD:

* README と実装が一致する
* 運用者が token / invite / binding の流れを追える
* 人に見せる overview と内部実装 docs の差が整理される

依存:

* T1
* T4
* T5

## Open Questions

以下は実装前に確定が必要である。

1. invite 完了の callback は frontend で受けるか、backend endpoint で受けるか
2. `guildId -> workspaceId` binding document を単独 collection にするか、workspace integration のみで解くか
3. bot 実行基盤を GCE 単体にするか MIG にするか
4. bot が読み取る channel scope を guild 全体にするか、将来 channel allowlist を持つか
5. install session の UI は Firestore snapshot 購読にするか、REST polling にするか

## 推奨初期解

初期版では次を推奨する。

* `1 workspace = 1 guild`
* bot 実行基盤は GCE 1 台
* Pub/Sub topic は `mind-events`
* `discord.message.received` 用 subscription を organize に追加
* token は GHA secret `DISCORD_BOT_TOKEN` -> Secret Manager
* guild binding は Firestore の `workspaces/{workspaceId}/integrations/discord` と `discord_guild_bindings/{guildId}` の 2 箇所
* install 完了は完全自動にせず、`discord_install_sessions/{sessionId}` と `on_guild_join` candidate を使った半自動 confirm にする
* candidate source は `guild_join` のみとし、confirm は Firestore transaction で反映する
