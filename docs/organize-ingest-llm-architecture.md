# Organize Ingest / LLM Architecture

このドキュメントは、巨大な会話履歴やログを Organize へ安全に投入し、Gemini Flash 系モデルを水平スケール前提で運用するための推奨構成を定義する。

目的は次の3つ。

* 6GB 級の履歴投入を「一発巨大 input」ではなく、再実行可能なバッチ処理へ分解する
* Organize 本体の責務を knowledge 化に集中させる
* Gemini Flash 系の TPM / RPM 制約を超えないよう、共有 limiter で全 worker を制御する

## 1. 基本方針

MUST:

* 会話 export の正規化・dedupe・chunking は Organize 本体に押し込まない
* Organize は chunk 済み input を受け取り、atom 化・topic 解決・node 更新に集中する
* LLM 呼び出しは各 worker のローカル判断で送らず、共有 limiter の permit を必須にする
* Gemini の preview 名を env key に埋め込まない（値で切り替える）
* インフラ系 env（API key、project id、Redis URL 等）は fallback なしで初期化時に検証する
* モデル名 env（`GEMINI_MODEL_FAST` / `GEMINI_MODEL_QUALITY`）はデフォルト値を持たせてよい

SHOULD:

* 常用モデルは Flash 系に寄せる
* review / difficult re-resolution のみ quality model を使う
* queue backlog, 429, tokens/min, permit wait を監視する

## 2. 推奨構成

```text
Chat Export / Log Files
  -> ActionIngest
    -> normalized chunks
      -> Queue / PubSub
        -> Organize Orchestrator / Workers
          -> Shared LLM Limiter
            -> Gemini Flash
          -> Firestore / GCS / Review Inbox
```

コンポーネントの責務は以下。

### 2.1 ActionIngest

責務:

* export format の読み込み
* message 正規化
* 重複除去
* chunking
* batch metadata 付与
* queue への publish

非責務:

* topic 判定
* node 生成
* review 判定

### 2.2 Queue / PubSub

責務:

* normalized chunk の非同期配送
* retry の起点
* worker 数と ingest 速度の decouple

要求:

* at-least-once delivery を前提に idempotent に扱う
* queue message は `batchId`, `threadId`, `chunkId`, `estimatedTokens` を持つ

### 2.3 Organize Workers

責務:

* chunk を Organize pipeline へ流す
* permit 取得後にだけ Gemini を叩く
* topic resolution / draft / outline / node update を行う
* low-confidence 結果を review inbox へ流す

非責務:

* raw export 修復
* 大容量ファイルの chunking
* グローバル rate limit の独自判断

### 2.4 Shared LLM Limiter

責務:

* model 単位の TPM / RPM / concurrency の一元制御
* estimate token 予約
* completion 後の actual token 補正
* 429 / timeout を capacity signal として吸収

推奨実装:

* Redis を共有 state backend とする
* 各 worker は `acquire` / `release` API 経由でのみ LLM を利用する

### 2.5 Review Inbox

責務:

* ambiguous attach/create 判定
* duplicate candidate
* low-signal chunk
* conflicting claim を人間へ返す

## 3. モデル方針

大量 ingest の常用モデルは Flash 系に寄せる。

理由:

* throughput が高い
* cost を抑えやすい
* topic resolution や summary 系の高頻度処理に向く

推奨:

* fast/default path: Flash
* difficult review path: Quality model

環境変数の命名は用途ベースにする。

良い例:

* `GEMINI_MODEL_FAST`
* `GEMINI_MODEL_QUALITY`

避ける:

* `GEMINI_PREVIEW_MODEL`
* `ORGANIZE_FLASH_PREVIEW_MODEL`

preview を使う場合でも env key には `preview` を埋め込まず、値で切り替える。

## 4. Queue Message 契約

normalized chunk を queue へ流す payload の推奨形。

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

MUST:

* `batchId`, `threadId`, `chunkId`, `inputId` を持つ
* token 予約のため `estimatedInputTokens` を持つ
* retry しても同一 chunk と認識できる stable id を持つ

### 4.1 Token Estimation

Gemini の公開 tokenizer API はないため、ingest 時は heuristic で推定する。

```ts
// UTF-8 バイト数 / 4 を基準にする（英語: ~4 bytes/token、日本語: ~1.5 bytes/token の中間）
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
```

SHOULD:

* 実際の usage と乖離が大きい場合は係数を調整する（`actual / estimated` を監視）
* 過大見積もりは throughput 低下、過小見積もりは 429 増加につながる
* `reservedOutputTokens` は処理種別ごとの上限値を固定で設定する（例: topic resolution = 512）

## 5. Limiter 設計

Flash 系の高 throughput を前提にしても、worker ごとの独立送信は禁止する。

共有 limiter は次の3種類の上限を扱う。

* TPM
* RPM
* in-flight concurrency

### 5.1 推奨 API

```ts
type AcquirePermitRequest = {
  model: string;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  requestId: string;
};

type AcquirePermitResult = {
  granted: boolean;
  retryAfterMs?: number;
};

type ReleasePermitRequest = {
  model: string;
  requestId: string;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  status: "ok" | "rate_limited" | "timeout" | "error";
};
```

### 5.2 Redis キー例

```text
llm:permit:{model}:rpm:{minute}      TTL: 120s（minute 境界 + 余裕）
llm:permit:{model}:tpm:{minute}      TTL: 120s（同上）
llm:permit:{model}:inflight          TTL: なし（INCR/DECR で管理）
llm:request:{requestId}              TTL: timeoutMs + 30s（crash 後の inflight 漏れ防止）
```

注意: `inflight` キーは worker crash 時に DECR されないリスクがある。
`llm:request:{requestId}` を TTL 付きで持ち、expired エントリを定期スキャンして補正するか、
`inflight` 自体も TTL 付きの sorted set（score = deadline_ms）で管理することを推奨する。

### 5.3 運用ルール

* permit は estimate で先取りする
* completion 後に actual usage で補正する
* 429 は障害ではなく capacity signal として扱う
* retry は exponential backoff + jitter を使う
* minute 境界ジャストの burst を避ける

#### Fixed window vs Sliding window

`rpm:{minute}` / `tpm:{minute}` の固定ウィンドウ方式は、minute 境界で前後 1 分間の 2× burst が理論上発生する。

許容できない場合は Redis sorted set による sliding window に切り替える（score = timestamp_ms、`ZREMRANGEBYSCORE` + `ZCARD` でカウント）。
初期実装は固定ウィンドウ + headroom 50% で運用し、429 増加が観測されたら sliding window へ移行する。

### 5.4 初期 headroom

理論上の上限いっぱいではなく、安全側から始める。

例:

* TPM target: 上限の 60% から開始
* RPM target: 上限の 50% から開始
* concurrency: 低めから開始し、latency / 429 を見ながら上げる

## 6. Organize 側に持たせる source metadata

大量履歴投入では source lineage を落とさないことが重要。

少なくとも次を input / atom / node のいずれかで追跡する。

* `sourceType`
* `sourceBatchId`
* `sourceConversationId`
* `sourceThreadId`
* `sourceChunkId`
* `sourceMessageIds`
* `sourceTimeRangeStart`
* `sourceTimeRangeEnd`

意図:

* 再投入時の trace
* thread continuity を使った topic attach 補助
* review 時の原文追跡

## 7. Topic Resolution 方針

同一 thread の連続 chunk は prior として使ってよいが、固定はしない。

優先順:

1. semantic similarity
2. recent same-thread attachment
3. same-speaker / same-time-range の補助信号
4. lexical overlap

禁止:

* 同一 thread だから常に同一 topic へ attach
* attach/create の confidence が低いのに強制 attach

曖昧な場合は review inbox へ送る。

## 8. Review Inbox 条件

初期ルール例:

* resolution confidence が低い
* top1 / top2 topic score の差が小さい
* 1 chunk から異常に多くの node が生成される
* quote 率や duplication が高い
* conflicting claims が検出される

review item には少なくとも以下を持たせる。

* `reviewType`
* `sourceBatchId`
* `sourceThreadId`
* `sourceChunkId`
* `sourceInputId`
* `candidateTopicIds`
* `reason`

## 9. 監視

最低限見るべきメトリクス:

* queue backlog
* queue age
* permit wait time
* acquire deny rate
* 429 rate
* timeout rate
* tokens/min by model
* requests/min by model
* average completion latency
* review creation rate
* attach_existing / create_new ratio

アラート候補:

* backlog が一定時間増え続ける
* 429 が連続して増える
* review 率が急増する
* create_new が急増して topic が乱立する

## 10. 推奨 env

用途ベースで分ける。

```bash
GEMINI_MODEL_FAST=gemini-3-flash-preview
GEMINI_MODEL_QUALITY=gemini-3.1-pro-preview

LLM_LIMITER_REDIS_URL=redis://...
LLM_LIMITER_TARGET_TPM=1200000
LLM_LIMITER_TARGET_RPM=10000
LLM_LIMITER_MAX_CONCURRENCY=50
```

MUST:

* env 初期化層で required check を行う
* `GOOGLE_API_KEY`, `LLM_LIMITER_REDIS_URL` 等のインフラ系 env は missing 時に即 error にする
* モデル名（`GEMINI_MODEL_FAST` / `GEMINI_MODEL_QUALITY`）はデフォルト値を持たせてよい

```ts
// 良い例: model 名はデフォルトあり
GEMINI_MODEL_FAST: z.string().default("gemini-3-flash-preview"),
GEMINI_MODEL_QUALITY: z.string().default("gemini-3.1-pro-preview"),

// 良い例: インフラ key は required
GOOGLE_API_KEY: z.string().min(1, "GOOGLE_API_KEY is required"),
LLM_LIMITER_REDIS_URL: z.string().min(1, "LLM_LIMITER_REDIS_URL is required"),
```

## 11. 導入順

最初の導入順は次を推奨する。

1. shared limiter を追加する（Redis バックエンド、acquire/release API）
2. Organize worker を permit 必須にする
3. ActionIngest を追加し、export -> normalized chunks を作る
4. queue message に stable id と token estimate を載せる
5. source metadata を write path へ通す
6. review inbox 条件を有効化する

**注意: step 1・2 を先行させる理由**

ActionIngest（step 3）を先に入れて複数 worker が Gemini を叩き始めると、limiter なしの状態で TPM/RPM を超えて 429 が連発する。shared limiter は worker 展開前に必ず完成させること。

## 12. 非目標

この構成では次は目標にしない。

* raw export の全形式自動修復
* queue なしの直接巨大投入
* 全 chunk を quality model で常用
* worker ローカルだけでの rate limiting
