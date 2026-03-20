# Ingest / Organize フロー詳細

ActionIngest によるチャット履歴の取り込みから、ActionOrganize による知識グラフ構築までの完全なフローを示す。

---

## 1. システム全体図

### 1-A. ActionIngest → Pub/Sub

```mermaid
flowchart LR
    subgraph ActionIngest["ActionIngest (CLI)"]
        FILE["入力ファイル<br>.json / .jsonl / GCS"]
        LOAD["loadInputSource"]
        PARSE["parseInput"]
        NORM["normalizeExport"]
        DEDUP["dedupeThread"]
        ASSET["persistThreadAssets<br>画像 → GCS"]
        CHUNK["buildChunkJobs"]
        PUB["publishChunkJobs"]
    end

    subgraph PubSub["Cloud Pub/Sub"]
        TOPIC["mind-events<br>organize.ingest.received"]
    end

    FILE --> LOAD --> PARSE --> NORM --> DEDUP --> ASSET --> CHUNK --> PUB --> TOPIC
```

### 1-B. ActionOrganize パイプライン概要

```mermaid
flowchart TD
    TOPIC["Pub/Sub<br>organize.ingest.received"]

    subgraph OI["受信"]
        RECV["OrganizeIngestReceivedHandler<br>InputRepository.upsert"]
    end

    subgraph A1["A1: Atomize"]
        IR["InputReceivedHandler<br>Gemini Fast → atom 抽出"]
    end

    subgraph A2["A2: TopicResolve + Draft"]
        AC["AtomCreatedHandler<br>Gemini Fast → topic 判定"]
        TR["TopicResolvedHandler<br>draft.md 追記"]
    end

    subgraph A3["A3: Bundle + Outline"]
        DU["DraftUpdatedHandler<br>bundle 生成"]
        BC["BundleCreatedHandler<br>Gemini Quality → 説明文<br>hierarchy plan 生成"]
        OU["OutlineUpdatedHandler<br>node 更新"]
    end

    subgraph A4["A4: NodeRollup"]
        NR["NodeRollupRequestedHandler<br>Gemini Fast → rollup 生成"]
    end

    TOPIC --> RECV --> IR --> AC --> TR --> DU --> BC --> OU --> NR
```

### 1-C. ストレージ書き込み先

```mermaid
flowchart LR
    RECV["OrganizeIngest<br>ReceivedHandler"]
    A1["InputReceived<br>Handler"]
    TR["TopicResolved<br>Handler"]
    DRAFT["A2DraftAppender<br>Service"]
    BC["BundleCreated<br>Handler"]
    OU["OutlineUpdated<br>Handler"]
    NR["NodeRollup<br>Handler"]

    FS_INPUT[("Firestore<br>inputs")]
    FS_ATOM[("Firestore<br>atoms")]
    FS_TOPIC[("Firestore<br>topics")]
    FS_NODE[("Firestore<br>nodes")]
    GCS_DRAFT[("GCS<br>drafts/*.md")]
    GCS_BUNDLE[("GCS<br>bundles/*.json")]
    GCS_NODE[("GCS<br>nodes/*.md")]
    REDIS[("Redis<br>LLM Limiter")]

    RECV -.-> FS_INPUT
    A1 -.-> FS_ATOM
    A1 <-.->|acquire/release| REDIS
    TR -.-> FS_TOPIC
    DRAFT -.-> GCS_DRAFT
    BC -.-> GCS_BUNDLE
    BC <-.->|acquire/release| REDIS
    OU -.-> FS_NODE
    NR -.-> GCS_NODE
    NR <-.->|acquire/release| REDIS
```

---

## 2. ActionIngest 詳細フロー

### 2-A. ファイル読み込み・正規化

```mermaid
flowchart TD
    START(["ActionIngest 起動<br>--input &lt;file&gt;"])

    subgraph load["読み込み"]
        L1["loadInputSource<br>ローカル / GCS / HTTP"]
        L2{"拡張子判定"}
        L3[".jsonl<br>行分割 JSON"]
        L4[".json<br>JSON.parse"]
    end

    subgraph normalize["正規化"]
        N1{"ルート構造判定"}
        N2["messages[]<br>→ 単一 thread"]
        N3["conversations[]<br>→ 複数 thread"]
        N4["threads[]<br>→ 複数 thread"]
        N5["message 正規化<br>role / text / timestamp / assets"]
        N6["timestamp 正規化<br>unix秒 / unix ms / ISO 文字列"]
        N7["dedupeThread<br>role+timestamp+text の hash で重複除去"]
    end

    START --> L1 --> L2
    L2 --> L3 & L4
    L3 & L4 --> N1
    N1 --> N2 & N3 & N4
    N2 & N3 & N4 --> N5 --> N6 --> N7
```

### 2-B. アセット処理・チャンク分割・発行

```mermaid
flowchart TD
    N7["dedupeThread 完了"]

    subgraph assets["アセット処理"]
        A1["画像パスを検出<br>imagePath / attachments / parts"]
        A2["GCS へアップロード<br>assetId を付与"]
        A3["storedAssetRef として<br>message に添付"]
    end

    subgraph chunk["チャンク分割"]
        C1["message を<br>[timestamp] role\ntext 形式にフォーマット"]
        C2["UTF-8 バイト ÷ 4<br>でトークン推定"]
        C3{"累積トークン ><br>targetChunkTokens?"}
        C4["バッファを flush<br>OrganizeChunkJob 生成"]
        C5["chunkId = chunk:{threadId}:{hash}<br>inputId = input:{hash}"]
    end

    subgraph publish["Pub/Sub 発行"]
        P1["OrganizeEnvelope 構築<br>type: organize.ingest.received<br>topicId: {prefix}:{threadId}"]
        P2["idempotencyKey =<br>type:.../threadId:.../chunkId:..."]
        P3["Pub/Sub publish<br>(emulator / GCP)"]
    end

    N7 --> A1 --> A2 --> A3
    A3 --> C1 --> C2 --> C3
    C3 -->|Yes| C4 --> C5 --> C3
    C3 -->|No, 末尾| C5
    C5 --> P1 --> P2 --> P3
```

---

## 3. ActionOrganize パイプライン詳細

### 3-A. 受信 → A1 Atomize

```mermaid
sequenceDiagram
    participant PubSub as Pub/Sub
    participant OI as OrganizeIngest<br/>ReceivedHandler
    participant A1 as InputReceived<br/>Handler
    participant Gemini as Gemini API
    participant Limiter as LLM Limiter<br/>(Redis)
    participant Store as Firestore / GCS

    PubSub->>OI: organize.ingest.received<br/>{OrganizeChunkJob}
    OI->>Store: InputRepository.upsert<br/>(source lineage 保存)
    OI->>PubSub: emit input.received

    PubSub->>A1: input.received
    A1->>Limiter: acquirePermit (fast)
    Limiter-->>A1: granted
    A1->>Gemini: atom 抽出・正規化<br/>(title / claim / kind / confidence)
    Gemini-->>A1: NormalizedAtom[]
    A1->>Limiter: releasePermit (actual tokens)
    A1->>Store: AtomRepository.upsert
    A1->>PubSub: emit atom.created {atomIds}
```

### 3-B. A2 TopicResolve + Draft

```mermaid
sequenceDiagram
    participant PubSub as Pub/Sub
    participant TR as TopicResolver<br/>Service
    participant A2 as TopicResolved<br/>Handler
    participant Draft as A2DraftAppender<br/>Service
    participant Gemini as Gemini API
    participant Limiter as LLM Limiter<br/>(Redis)
    participant Store as Firestore / GCS

    PubSub->>TR: atom.created
    TR->>Store: TopicRepository.listCandidates
    TR->>Store: AtomRepository.getByIds
    TR->>TR: lexical scoring (候補上位5件)
    TR->>Limiter: acquirePermit (fast)
    Limiter-->>TR: granted
    TR->>Gemini: topic 判定<br/>(attach_existing / create_new)
    Gemini-->>TR: {decision, confidence, reason}
    TR->>Limiter: releasePermit

    alt confidence < 0.75 または scoreGap < 0.15
        TR->>Store: OrganizeReviewRepository.upsert
    end

    TR->>PubSub: emit topic.resolved

    PubSub->>A2: topic.resolved
    A2->>Store: onTopicResolved (topic 状態更新)
    A2->>Draft: appendDraft<br/>(draft.md に atom 追記)
    Draft->>Store: GCS draft 読み書き
    A2->>PubSub: emit draft.updated
```

### 3-C. A3 Bundle + Outline

```mermaid
sequenceDiagram
    participant PubSub as Pub/Sub
    participant A3 as DraftUpdated/<br/>BundleCreated Handler
    participant Bundle as PipelineWrite<br/>Service
    participant Gemini as Gemini API
    participant Limiter as LLM Limiter<br/>(Redis)
    participant Store as Firestore / GCS

    PubSub->>A3: draft.updated
    A3->>Bundle: onDraftUpdated (bundle 生成判断)
    A3->>PubSub: emit bundle.created

    PubSub->>A3: bundle.created
    A3->>Bundle: onBundleCreated
    Note over Bundle: buildHierarchyPlan<br/>cluster / subcluster 構造決定<br/>MIN_CLAIMS_FOR_CLUSTER=2
    A3->>Limiter: acquirePermit (quality)
    Limiter-->>A3: granted
    A3->>Gemini: bundle 説明文生成
    Gemini-->>A3: description
    A3->>Limiter: releasePermit
    A3->>Store: GCS bundle 書き込み
    A3->>PubSub: emit bundle.described
    A3->>PubSub: emit outline.updated

    PubSub->>A3: outline.updated
    A3->>Bundle: onOutlineUpdated (node 更新)
    A3->>Store: NodeRepository.upsert
    A3->>PubSub: emit topic.node_changed (changedNodeIds 分)
```

### 3-D. A4 NodeRollup

```mermaid
sequenceDiagram
    participant PubSub as Pub/Sub
    participant A4 as NodeRollup<br/>Handler
    participant Gemini as Gemini API
    participant Limiter as LLM Limiter<br/>(Redis)
    participant Store as Firestore / GCS

    loop 変更された各 node
        PubSub->>A4: topic.node_changed
        A4->>PubSub: emit node.rollup_requested

        PubSub->>A4: node.rollup_requested
        A4->>Limiter: acquirePermit (fast)
        Limiter-->>A4: granted
        A4->>Gemini: node rollup 生成<br/>(子 atom を統合)
        Gemini-->>A4: rollup content
        A4->>Limiter: releasePermit
        A4->>Store: GCS node 書き込み
        A4->>PubSub: emit node.rollup.updated
    end
```

---

## 4. LLM Limiter フロー

### 4-A. permit 取得 (Lua atomic)

```mermaid
flowchart TD
    CALL["callGemini 呼び出し"]
    PERMIT["acquirePermit<br>estimatedInputTokens 計算<br>(UTF-8 bytes / 4)"]

    subgraph LUA["Redis Lua Script (atomic)"]
        CLEANUP["ZREMRANGEBYSCORE inflight<br>期限切れエントリを削除"]
        CHK_INF{"inflight + 1<br>> maxConcurrency?"}
        CHK_IDEM{"requestKey<br>既存?"}
        CHK_RPM{"rpm + 1<br>> targetRpm?"}
        CHK_TPM{"tpm + tokens<br>> targetTpm?"}
        GRANT["SET requestKey EX ttl<br>INCRBY rpm / tpm<br>ZADD inflight deadline:reqId<br>return 1"]
    end

    DENY_INF["return -1<br>retryAfterMs = 250ms"]
    DENY_RT["return -2<br>retryAfterMs = 次 minute まで"]
    IDEM["return 0<br>(idempotent grant)"]
    THROW["TemporaryDependencyError<br>→ Pub/Sub retry"]

    CALL --> PERMIT --> CLEANUP --> CHK_INF
    CHK_INF -->|Yes| DENY_INF --> THROW
    CHK_INF -->|No| CHK_IDEM
    CHK_IDEM -->|Yes| IDEM
    CHK_IDEM -->|No| CHK_RPM
    CHK_RPM -->|Yes| DENY_RT --> THROW
    CHK_RPM -->|No| CHK_TPM
    CHK_TPM -->|Yes| DENY_RT
    CHK_TPM -->|No| GRANT

    style DENY_INF fill:#f88,color:#000
    style DENY_RT fill:#f88,color:#000
    style THROW fill:#f88,color:#000
    style GRANT fill:#8f8,color:#000
    style IDEM fill:#8f8,color:#000
```

### 4-B. Gemini 呼び出し → permit 解放

```mermaid
flowchart TD
    GRANTED["permit granted<br>(GRANT or IDEM)"]
    FETCH["Gemini API 呼び出し"]
    ERROR{"エラー?"}
    RESULT["validate(parsed)"]

    subgraph RELEASE["releaseLlmPermit"]
        DEL["DEL requestKey"]
        ZREM["ZREM inflight requestId"]
        CORRECT["INCRBY tpm<br>(actual - reserved)<br>actual = promptTokens + candidateTokens"]
    end

    GRANTED --> FETCH --> ERROR
    ERROR -->|timeout / network| RELEASE
    ERROR -->|No| RESULT --> RELEASE
```

---

## 5. Review Inbox 振り分け条件

```mermaid
flowchart TD
    RESOLVE["TopicResolverService.resolve()"]
    COND1{"confidence < 0.75?"}
    COND2{"scoreGap < 0.15?<br>(top1 - top2 スコア差)"}
    REVIEW["OrganizeReviewRepository.upsert<br>reviewType: topic_resolution_ambiguous<br>sourceBatchId / sourceChunkId 保存"]
    PROCEED["topic.resolved を emit<br>shouldReview: true を payload に含める"]

    RESOLVE --> COND1
    COND1 -->|Yes| REVIEW
    COND1 -->|No| COND2
    COND2 -->|Yes| REVIEW
    COND2 -->|No| PROCEED
    REVIEW --> PROCEED
```

---

## 6. InputProgress 状態遷移

```mermaid
stateDiagram-v2
    [*] --> received : organize.ingest.received

    received --> atomizing : input.received (A1 開始)
    atomizing --> resolving_topic : atom.created
    resolving_topic --> updating_draft : topic.resolved
    updating_draft --> completed : outline.updated + node rollup 完了

    atomizing --> failed : Gemini エラー / 検証失敗
    resolving_topic --> failed : Gemini エラー
    updating_draft --> failed : 書き込みエラー
```
