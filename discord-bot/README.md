# discord-bot

Discord Bot service. Listens to Discord guild channels via WebSocket (`discord.py`), resolves the target workspace from Firestore, stores each message in GCS as JSON, updates the Discord structure index in Firestore, and publishes `discord.message.received` to `mind-events`.

## 動作フロー

```
Discord Gateway (WebSocket)
  → on_message() で guild message を受信
    → Firestore discord_guild_bindings/{guildId} から workspace を解決
    → GCS に JSON として書き込み
      (discord/{workspaceId}/{channelOrThreadId}/{messageId}.json)
    → Firestore に discord_channels / discord_threads index を upsert
    → mind-events に discord.message.received を publish
      → organize が DiscordMessageReceivedHandler で処理
```

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | ✅ | Discord Bot トークン |
| `GCS_BUCKET` | ✅ | ログ書き込み先 GCS バケット |
| `GOOGLE_CLOUD_PROJECT` | ✅ | GCP プロジェクト ID |
| `PUBSUB_TOPIC_NAME` | ✅ | publish 先 Pub/Sub topic 名 (`mind-events`) |

Guild と workspace の対応は環境変数ではなく Firestore を正本とする。

* `discord_guild_bindings/{guildId}`
  * `workspaceId`
  * `guildId`
  * `guildName`
  * `enabled`
  * `status`
* `workspaces/{workspaceId}/discord_channels/{channelId}`
* `workspaces/{workspaceId}/discord_threads/{threadId}`

## Discord Developer Portal 設定

- **Privileged Gateway Intents** → `MESSAGE CONTENT INTENT` を有効化
- **Bot Permissions** → `Read Messages/View Channels` のみ（Guild 内チャンネル限定）
- **OAuth2 Scopes** → `bot`

## デプロイ対象

GCE VM（常駐プロセス）。docker compose では `full` profile で起動。

## ローカル開発

```bash
# 実際のトークンは .env に記述し .gitignore 済み
docker compose --profile full up discord-bot
```
