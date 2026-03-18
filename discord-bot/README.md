# discord-bot

Discord Bot service. Listens to Guild channels via WebSocket (discord.py) and flushes buffered messages to GCS as Markdown on `discord.flush_requested` Pub/Sub events.

## 動作フロー

```
Discord Gateway (WebSocket)
  → on_message() でバッファに蓄積（Guild チャンネルのみ）
    → Pub/Sub sub-discord-bot が discord.flush_requested を受信
      → GCS に Markdown として書き込み
        (discord/{guildId}/{channelId}/{date}_{batchId}.md)
      → mind-events に media.received を publish
        → A0 が gcs_object として処理（text/* パス、discord_chat_log）
```

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | ✅ | Discord Bot トークン |
| `DISCORD_GUILD_IDS` | ✅ | 監視対象の Guild ID（カンマ区切り） |
| `GCS_BUCKET` | ✅ | ログ書き込み先 GCS バケット |
| `GOOGLE_CLOUD_PROJECT` | ✅ | GCP プロジェクト ID |
| `PUBSUB_TOPIC_NAME` | 任意 | mind-events トピック名（default: `mind-events`） |
| `PUBSUB_FLUSH_SUBSCRIPTION` | 任意 | flush 受信用サブスクリプション（default: `sub-discord-bot`） |
| `WORKSPACE_ID` | 任意 | media.received に埋め込む workspace ID（default: `default`） |
| `FLUSH_POLL_INTERVAL` | 任意 | Pub/Sub ポーリング間隔（秒、default: `5`） |

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

flush をトリガーしたい場合（emulator 経由）:

```bash
# pubsub emulator に discord.flush_requested を直接 publish
curl -s -X POST \
  "http://localhost:8085/v1/projects/local-dev/topics/discord-flush-requests:publish" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"data":"e30="}]}'
```
