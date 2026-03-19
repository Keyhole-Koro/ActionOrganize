# Organize Ingest / LLM Implementation Tickets

この文書は [`organize-ingest-llm-architecture.md`](./organize-ingest-llm-architecture.md) を、現在の `ActionOrganize` コードベースに馴染む形で実装へ落とすためのチケット分解を定義する。

## 実装前提

現在の `ActionOrganize` 実装は次の形を前提にする。

* event は `EventEnvelope` + `payload: Record<string, unknown>` で流れる
* Firestore は topic 配下だけでなく `workspaces/{workspaceId}/inputs`, `atoms`, `nodes`, `inputProgress` のような workspace 直下 collection を多用している
* `A0/A1` は `input.received` を canonical な内部イベントとして扱っている
* `EventProcessor` / `EventPublisher` / repository 群を崩さずに拡張する方が安全

この前提から、以下を設計方針として固定する。

* review inbox は `workspaces/{workspaceId}/organizeReviews/{reviewId}` に置く
* lineage は `inputs` を正本、`atoms` を詳細参照、`nodes` を集約参照とする
* ingest 入口は `organize.ingest.received` を追加し、そこから canonical `input.received` へ橋渡しする

## 実装順

1. T1 Shared LLM Limiter 基盤
2. T2 Gemini Client の Permit 必須化
3. T3 TopicResolver を正規経路へ戻す
4. T4 Ingest Job 契約と Event 拡張
5. T5 ActionIngest サービス新設
6. T6 Organize 入口の Ingest Job 受理
7. T7 Source Lineage の永続化
8. T8 Review Inbox 導入
9. T9 Metrics / Ops
10. T10 Cutover / Rollout

この順を固定する理由:

* limiter なしで ingest worker を増やすと `429` が増える
* 先に `TopicResolver` を戻さないと downstream の設計判断が歪む
* ingest job 契約を先に決めないと `ActionIngest` 実装がぶれる

## T1. Shared LLM Limiter 基盤

目的:

* Gemini の `TPM` / `RPM` / `concurrency` を worker 横断で一元制御する

対象:

* `ActionOrganize/src/config/env.ts`
* `ActionOrganize/src/lib/llm-limiter.ts` 新設
* `ActionOrganize/package.json`
* limiter 単体テスト

作業内容:

* Redis backend の `acquire` / `release` API を実装する
* `requestId` 単位で permit を管理する
* estimate で先取りし、release 時に actual usage で補正する
* inflight leak 対策として request TTL と補正戦略を入れる
* 初期実装は fixed window + headroom 50% とする

追加 env:

* `LLM_LIMITER_REDIS_URL` required
* `LLM_LIMITER_TARGET_TPM` required
* `LLM_LIMITER_TARGET_RPM` required
* `LLM_LIMITER_MAX_CONCURRENCY` required

設計メモ:

* model 名は既存どおり `GEMINI_MODEL_FAST` / `GEMINI_MODEL_QUALITY` を使う
* limiter key は model 単位で分ける
* env fallback は入れない

DoD:

* env 初期化時に required check が走る
* `granted=false` のとき `retryAfterMs` を返せる
* RPM / TPM / concurrency の最低限のテストが通る
* limiter 単体で crash recovery 可能な前提を持つ

依存:

* なし

## T2. Gemini Client の Permit 必須化

目的:

* `ActionOrganize` の Gemini 呼び出しを shared limiter 経由に統一する

対象:

* `ActionOrganize/src/lib/gemini-client.ts`
* Gemini 呼び出しを持つ service
* テスト更新

作業内容:

* `callGemini()` に permit acquire を必須化する
* 共通 token estimate 関数を導入する
* release 時に `ok | rate_limited | timeout | error` を渡す
* `429` / timeout / network error を capacity signal として limiter に返す
* log context に `requestId`, `model`, `estimatedInputTokens`, `reservedOutputTokens`, `permitWaitMs` を載せる

設計メモ:

* 既存の quality fallback ロジックは limiter 導入後に再評価する
* worker ごとの暗黙 fallback ではなく、明示的 policy として扱う

DoD:

* permit なしで Gemini を叩く経路が残らない
* limiter deny / timeout / 429 のテストがある
* 既存 service の呼び出し側を大きく壊さず差し替えられる

依存:

* T1

## T3. TopicResolver を正規経路へ戻す

目的:

* `atom.created -> TopicResolver -> topic.resolved` を現行 pipeline で有効化する

対象:

* `ActionOrganize/src/agents/handlers/pipeline-handlers.ts`
* `ActionOrganize/src/services/topic-resolver-service.ts`
* resolver テスト

現状差分:

* `AtomCreatedHandler` が upload topic へ固定 attach している

作業内容:

* `AtomCreatedHandler` から `TopicResolverService` を呼ぶ
* fixed attach を削除する
* same-thread continuity は補助信号としてのみ使う
* `topic.resolved` payload に次を載せる
* `resolvedTopicId`
* `resolutionMode`
* `resolutionConfidence`
* `resolutionReason`
* `candidateTopicIds`
* `candidateTopicStates`

設計メモ:

* `topic.resolved` は既存後段がそのまま消費できる形を維持する
* review inbox はこの時点では emit せず、review 候補に必要な情報を payload に残す

DoD:

* `AtomCreatedHandler` の固定 attach ロジックが消える
* resolver 結果が `topic.resolved` に載って後段へ流れる
* log に `candidateTopicIds`, `resolvedTopicId`, `resolutionConfidence` が残る

依存:

* T2

## T4. Ingest Job 契約と Event 拡張

目的:

* `ActionIngest` と `ActionOrganize` を繋ぐ契約を current codebase 向けに固定する

対象:

* `ActionOrganize/src/models/envelope.ts`
* `ActionOrganize/src/models/organize-ingest-job.ts` 新設
* handler payload validation
* `EventPublisher` optional attributes 拡張

作業内容:

* `OrganizeChunkJob` 型を導入する
* 新イベント `organize.ingest.received` の payload 契約を定義する
* optional attributes に ingest 系 field を追加する
* payload validation を追加する

固定する job 形:

```ts
type OrganizeChunkJob = {
  sourceType: "chat_history";
  batchId: string;
  conversationId: string;
  threadId: string;
  chunkId: string;
  chunkIndex: number;
  inputId: string;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  priority: "high" | "normal" | "low";
  timeRange: {
    start: string;
    end: string;
  };
  messageIds: string[];
  text: string;
};
```

新イベント方針:

* `organize.ingest.received` は外部 ingest 入口専用とする
* `input.received` は Organize 内部の canonical イベントとして維持する

追加 optional attributes 候補:

* `batchId`
* `threadId`
* `chunkId`
* `conversationId`

DoD:

* ingest chunk を stable id で再識別できる
* `organize.ingest.received` payload validation がある
* `input.received` の意味を壊さずに ingest 専用 event を追加できる

依存:

* T3

## T5. ActionIngest サービス新設

目的:

* raw export の正規化・dedupe・chunking を Organize 本体の外に分離する

対象:

* `ActionIngest/` 新設
* export parser
* message normalizer
* deduper
* chunker
* Pub/Sub publisher

作業内容:

* chat export / log files を入力として受ける
* normalized message へ変換する
* 重複 message を除去する
* chunking して `OrganizeChunkJob` を作る
* `estimatedInputTokens` を heuristic で計算する
* `organize.ingest.received` を publish する

設計メモ:

* stable id は `batchId/threadId/chunkIndex/messageIds` を元に決定論的に作る
* `inputId` は chunk 単位の pipeline 主キーとして発行する
* raw export repair は非目標

DoD:

* 大容量履歴を chunk 単位で publish できる
* 再実行でも stable id が変わらない
* Organize 側が raw export format を知らずに済む

依存:

* T4

## T6. Organize 入口の Ingest Job 受理

目的:

* `ActionIngest` が出した `organize.ingest.received` を既存 pipeline に接続する

対象:

* `ActionOrganize/src/agents/handlers/pipeline-handlers.ts`
* `ActionOrganize/src/services/a0-a1-write-service.ts`
* `ActionOrganize/src/services/event-publisher.ts`
* 入口テスト

作業内容:

* `OrganizeIngestReceivedHandler` を追加する
* `organize.ingest.received` から次を行う
* `inputs/{inputId}` を upsert する
* `inputProgress/{inputId}` を `atomizing` か適切な初期状態へ進める
* canonical `input.received` を emit する
* `input.received.payload` へ `text` と lineage を引き継ぐ
* idempotency key は `chunkId` ベースで作る

canonical 化の方針:

* 外部 ingest event の責務は「chunk を持ち込むこと」
* 内部 `input.received` の責務は「A1 が処理できる正規化済み入力」で統一する

DoD:

* `organize.ingest.received` 1件が pipeline 1件に対応する
* duplicate delivery でも ledger で無害化できる
* A1 は既存の `input.received` 契約で動作し続ける

依存:

* T5

## T7. Source Lineage の永続化

目的:

* 現行 repository 構造に合わせて lineage を保持し、後から trace できるようにする

対象:

* `ActionOrganize/src/repositories/input-repository.ts`
* `ActionOrganize/src/repositories/atom-repository.ts`
* `ActionOrganize/src/repositories/node-repository.ts`
* bundle / outline write path
* 関連 type 定義

保持方針:

* `inputs` を lineage 正本にする
* `atoms` は詳細参照を持つ
* `nodes` は集約参照のみ持つ

追加 field 案:

`inputs/{inputId}`:

* `sourceType`
* `sourceBatchId`
* `sourceConversationId`
* `sourceThreadId`
* `sourceChunkId`
* `sourceMessageIds`
* `sourceTimeRangeStart`
* `sourceTimeRangeEnd`

`atoms/{atomId}`:

* `sourceInputId`
* `sourceBatchId`
* `sourceThreadId`
* `sourceChunkId`
* `sourceMessageIds`
* `sourceTimeRangeStart`
* `sourceTimeRangeEnd`

`nodes/{nodeId}`:

* `sourceInputIds`
* `sourceChunkIds`
* `sourceThreadIds`
* `evidenceAtomIds`

作業内容:

* input / atom / node record 型を拡張する
* `A0/A1/A2/A3` の write path で lineage を落とさず通す
* `NodeRepository` には message 単位の完全複製を持たせない

DoD:

* review 時に `node -> atom -> input` で元 chunk を追える
* same-thread continuity を resolver の補助信号に使える
* `nodes` が過剰に肥大化しない

依存:

* T6

## T8. Review Inbox 導入

目的:

* あいまいな解決結果を current codebase に馴染む形で永続化する

対象:

* `ActionOrganize/src/repositories/organize-review-repository.ts` 新設
* TopicResolver / Cleaner 判定
* Firestore write path

collection path:

* `workspaces/{workspaceId}/organizeReviews/{reviewId}`

review item 型:

* `reviewId`
* `reviewType`
* `workspaceId`
* `topicId`
* `status`
* `sourceInputId`
* `sourceBatchId`
* `sourceThreadId`
* `sourceChunkId`
* `candidateTopicIds`
* `reason`
* `metadata`
* `createdAt`
* `updatedAt`

初期 review 条件:

* resolution confidence が低い
* top1 / top2 score gap が小さい
* invalid attach candidate
* conflicting claim
* 1 chunk あたり異常な node 生成数

設計メモ:

* review は knowledge graph の一部ではなく ops/work queue として扱う
* topic 配下 collection ではなく workspace 直下 collection に置く
* resolver と cleaner の両方から書ける形にする

DoD:

* 曖昧ケースが silent failure せず review に残る
* review item から source chunk と candidate topic を辿れる
* review path が既存 workspace 直下 collection の設計に馴染む

依存:

* T3
* T7

## T9. Metrics / Ops

目的:

* 大量 ingest の運用状態を可視化する

対象:

* logger
* limiter metrics
* queue backlog / age 監視
* ops docs

作業内容:

* 次の metrics を最低限出す
* `queue_backlog`
* `queue_age`
* `permit_wait_ms`
* `permit_deny_rate`
* `gemini_429_rate`
* `gemini_timeout_rate`
* `tokens_per_minute_by_model`
* `requests_per_minute_by_model`
* `completion_latency_ms`
* `review_creation_rate`
* `attach_existing_ratio`
* `create_new_ratio`

DoD:

* limiter と resolver の健全性を時系列で見られる
* 429 増加や topic 乱立を検知できる

依存:

* T1
* T2
* T8

## T10. Cutover / Rollout

目的:

* limiter なし worker 展開を防ぎつつ段階導入する

対象:

* deploy workflow
* runbook
* feature flags が必要なら追加

作業内容:

* limiter 未設定では ingest 系 worker を有効化しない
* rollout 順を固定する
* dev / staging / prod の env checklist を作る
* rollback 条件を決める

DoD:

* limiter 導入前に ingest が有効化されない
* 導入順と rollback 条件が文書化される

依存:

* T1-T9

## 最初のスプリント

最初の実装スプリントは次で固定する。

1. T1 Shared LLM Limiter 基盤
2. T2 Gemini Client の Permit 必須化
3. T3 TopicResolver を正規経路へ戻す

理由:

* 現状のボトルネックは ingest 不在より limiter 不在
* resolver 固定 attach を残したまま ingest を作ると、誤 attach を大量に増やす
* T1-T3 を終えると ingest 契約を安全に接続できる
