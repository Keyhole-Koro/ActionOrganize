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

## Endpoints

* `GET /healthz`
  * プロセス状態と対応イベント一覧を返します
* `POST /events`
  * Pub/Sub push 互換のリクエストを受けます
  * `message.data` は base64 化した Organize envelope JSON を想定します

## Environment

* `PORT` default: `8090`
* `GOOGLE_CLOUD_PROJECT` default: `local-dev`
* `PUBSUB_EMULATOR_HOST` default: `localhost:8085`
* `FIRESTORE_EMULATOR_HOST` default: `localhost:8081`
* `STORAGE_EMULATOR_HOST` default: `http://localhost:4443`
* `VERTEX_USE_REAL_API` default: `false`
