# ActionOrganize

Node.js + TypeScript + Express で動く Organize backend です。

## Scripts

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

起動時に必須環境変数を検証します。missing や空文字では起動しません。

Firestore/Pub/Sub emulator と合わせる場合の例:

```bash
PORT=8090 \
GOOGLE_CLOUD_PROJECT=local-dev \
FIRESTORE_EMULATOR_HOST=localhost:8081 \
STORAGE_EMULATOR_HOST=http://localhost:4443 \
PUBSUB_EMULATOR_HOST=localhost:8085 \
PUBSUB_TOPIC_NAME=mind-events \
STATE_BACKEND=memory \
PUBSUB_PUBLISH_ENABLED=false \
LEASE_TTL_SECONDS=120 \
VERTEX_USE_REAL_API=false \
npm run dev
```

## Endpoints

* `GET /healthz`
  * プロセス状態と対応イベント一覧を返します
* `POST /events`
  * Pub/Sub push 互換のリクエストを受けます
  * `message.data` は base64 化した Organize envelope JSON を想定します

## Current Scope

現在は次まで実装済みです。

* event intake
* event ledger / lease
* emitted event publish
* A0/A1/TopicResolver/A2/A3b/A3/A4/A7 相当の最小 write path
  * `inputs/{inputId}`
  * `atoms/{atomId}`
  * `inputProgress/{inputId}`
  * `pipelineBundles/{bundleId}`
  * `topics/{topicId}.latestDraftVersion`
  * `topics/{topicId}.latestOutlineVersion`
  * `topics/{topicId}.latestMapVersion`
  * `drafts/{version}`
  * `outlines/{version}`
  * `nodes/{nodeId}`
  * `indexItems/{indexItemId}`

`STATE_BACKEND=memory` では ledger / lease / handler の動作確認ができ、`STATE_BACKEND=firestore` では Firestore への永続化を行います。

## Environment

Required:

* `PORT`
* `STATE_BACKEND`
  * `memory` or `firestore`
* `GOOGLE_CLOUD_PROJECT`
* `PUBSUB_EMULATOR_HOST`
* `PUBSUB_TOPIC_NAME`
* `PUBSUB_PUBLISH_ENABLED`
  * `true` or `false`
* `FIRESTORE_EMULATOR_HOST`
* `STORAGE_EMULATOR_HOST`
* `LEASE_TTL_SECONDS`
  * positive integer
* `VERTEX_USE_REAL_API`
  * `true` or `false`

Optional:

* `NODE_ENV`
  * `development`, `test`, `production`
