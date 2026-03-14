# ActionOrganize

Node.js + TypeScript + Express で動く Organize backend です。

## Scripts

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

既定の待受は `http://localhost:8090` です。

Firestore/Pub/Sub emulator と合わせる場合の例:

```bash
FIRESTORE_EMULATOR_HOST=localhost:8081 \
PUBSUB_EMULATOR_HOST=localhost:8085 \
STATE_BACKEND=memory \
PUBSUB_PUBLISH_ENABLED=false \
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
* A0/A1 相当の最小 write path
  * `inputs/{inputId}`
  * `atoms/{atomId}`
  * `inputProgress/{inputId}`

`STATE_BACKEND=memory` では ledger / lease / handler の動作確認ができ、`STATE_BACKEND=firestore` では Firestore への永続化を行います。

## Environment

* `PORT` default: `8090`
* `STATE_BACKEND` default: `memory`
* `GOOGLE_CLOUD_PROJECT` default: `local-dev`
* `PUBSUB_EMULATOR_HOST` default: `localhost:8085`
* `PUBSUB_TOPIC_NAME` default: `mind-events`
* `PUBSUB_PUBLISH_ENABLED` default: `false`
* `FIRESTORE_EMULATOR_HOST` default: `localhost:8081`
* `STORAGE_EMULATOR_HOST` default: `http://localhost:4443`
* `LEASE_TTL_SECONDS` default: `120`
* `VERTEX_USE_REAL_API` default: `false`
