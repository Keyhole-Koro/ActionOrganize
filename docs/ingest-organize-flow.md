# Ingest / Organize フロー詳細

ActionIngest によるチャット履歴の取り込みから、ActionOrganize による知識グラフ構築までの完全なフローを示す。

---

## 1. 全体構成

```mermaid
flowchart TD
    subgraph ActionIngest["ActionIngest (CLI)"]
        FILE["入力ファイル\n.json / .jsonl / GCS"]
        LOAD["loadInputSource"]
        PARSE["parseInput\njson / jsonl"]
        NORM["normalizeExport\nconversations / threads / messages"]
        DEDUP["dedupeThread\nrole+timestamp+text hash"]
        ASSET["persistThreadAssets\n画像 → GCS upload"]
        CHUNK["buildChunkJobs\ntargetChunkTokens 単位で分割"]
        PUB["publishChunkJobs\nPub/Sub publish"]
    end

    subgraph PubSub["Cloud Pub/Sub"]
        TOPIC["mind-events topic\ntype: organize.ingest.received"]
    end

    subgraph ActionOrganize["ActionOrganize (Worker)"]
        direction TB
        RECV["OrganizeIngestReceivedHandler\n→ InputRepository.upsert\n→ emit input.received"]

        subgraph A1["A1: Atomize"]
            IR["InputReceivedHandler"]
            GEM1["Gemini Fast\natom 抽出・正規化"]
            ATOMS["AtomRepository.upsert"]
        end

        subgraph A2["A2: TopicResolve + Draft"]
            AC["AtomCreatedHandler"]
            GEM2["Gemini Fast\ntopic 判定\nattach_existing / create_new"]
            REVIEW["OrganizeReviewRepository\n低信頼度 → review inbox"]
            TR["TopicResolvedHandler\n→ onTopicResolved"]
            DRAFT["A2DraftAppenderService\ndraft に atom 追記"]
        end

        subgraph A3["A3: Bundle + Outline"]
            DU["DraftUpdatedHandler\n→ onDraftUpdated"]
            BC["BundleCreatedHandler\n→ onBundleCreated\nhierarchy plan 生成"]
            GEM3["Gemini Quality\nbundle 説明文生成"]
            BD["BundleDescribedHandler"]
            OU["OutlineUpdatedHandler\n→ onOutlineUpdated"]
        end

        subgraph A4["A4: NodeRollup"]
            NC["TopicNodeChangedHandler"]
            NR["NodeRollupRequestedHandler\n→ onNodeRollupRequested"]
            GEM4["Gemini Fast\nnode rollup 生成"]
        end
    end

    subgraph Storage["Firestore / GCS"]
        FS_INPUT["inputs コレクション\nsource lineage 保持"]
        FS_ATOM["atoms コレクション"]
        FS_TOPIC["topics コレクション"]
        FS_NODE["nodes コレクション"]
        GCS_DRAFT["GCS: drafts/*.md"]
        GCS_BUNDLE["GCS: bundles/*.json"]
        GCS_NODE["GCS: nodes/*.md"]
    end

    subgraph Limiter["Shared LLM Limiter"]
        REDIS["Redis\nTPM / RPM / inflight\n(Lua atomic)"]
    end

    FILE --> LOAD --> PARSE --> NORM --> DEDUP --> ASSET --> CHUNK --> PUB
    PUB --> TOPIC
    TOPIC --> RECV

    RECV --> IR
    IR --> GEM1 --> ATOMS --> AC
    AC --> GEM2
    GEM2 -->|低信頼| REVIEW
    GEM2 --> TR --> DRAFT
    DRAFT --> DU --> BC
    BC --> GEM3 --> BD
    BC --> OU --> NC --> NR --> GEM4

    GEM1 & GEM2 & GEM3 & GEM4 <-->|acquire / release permit| REDIS

    RECV -.-> FS_INPUT
    ATOMS -.-> FS_ATOM
    TR -.-> FS_TOPIC
    DRAFT -.-> GCS_DRAFT
    BC -.-> GCS_BUNDLE
    OU -.-> FS_NODE
    NR -.-> GCS_NODE
```

---

## 2. ActionIngest 詳細フロー

```mermaid
flowchart TD
    START(["ActionIngest 起動\n--input <file>"])

    subgraph load["ファイル読み込み"]
        L1["loadInputSource\nローカル / GCS / HTTP"]
        L2{"形式判定"}
        L3[".jsonl → 行分割 JSON"]
        L4[".json → JSON.parse"]
    end

    subgraph normalize["正規化"]
        N1{"ルート構造判定"}
        N2["messages[] → 単一 thread"]
        N3["conversations[] → 複数 thread"]
        N4["threads[] → 複数 thread"]
        N5["各 message を正規化\nrole / text / timestamp / assets"]
        N6["timestamp 正規化\nunix秒 / unix ms / ISO 文字列"]
        N7["dedupeThread\nrole+timestamp+text の hash で重複除去"]
    end

    subgraph assets["アセット処理"]
        A1["画像パスを検出\nimagePath / attachments / parts"]
        A2["GCS へアップロード\nassetId を付与"]
        A3["storedAssetRef として message に添付"]
    end

    subgraph chunk["チャンク分割"]
        C1["各 message を\n[timestamp] role\\ntext 形式にフォーマット"]
        C2["UTF-8 バイト ÷ 4 でトークン推定"]
        C3{"累積トークン >\ntargetChunkTokens?"}
        C4["現バッファを flush → OrganizeChunkJob 生成"]
        C5["chunkId = chunk:{threadId}:{hash}\ninputId = input:{hash}"]
    end

    subgraph publish["Pub/Sub 発行"]
        P1["OrganizeEnvelope を構築\ntype: organize.ingest.received\ntopicId: {prefix}:{threadId}"]
        P2["idempotencyKey =\ntype:.../threadId:.../chunkId:..."]
        P3["Pub/Sub publish\n(emulator / GCP)"]
    end

    START --> L1 --> L2
    L2 --> L3 & L4
    L3 & L4 --> N1
    N1 --> N2 & N3 & N4
    N2 & N3 & N4 --> N5 --> N6 --> N7
    N7 --> A1 --> A2 --> A3
    A3 --> C1 --> C2 --> C3
    C3 -->|Yes| C4 --> C5 --> C3
    C3 -->|No, 末尾| C5
    C5 --> P1 --> P2 --> P3
```

---

## 3. ActionOrganize パイプライン詳細フロー

```mermaid
sequenceDiagram
    participant PubSub as Pub/Sub
    participant OI as OrganizeIngest<br/>ReceivedHandler
    participant A1 as InputReceived<br/>Handler (A1)
    participant TR as TopicResolver<br/>Service
    participant A2 as TopicResolved<br/>Handler (A2)
    participant Draft as A2DraftAppender<br/>Service
    participant A3 as DraftUpdated<br/>Handler (A3)
    participant Bundle as PipelineWrite<br/>Service
    participant A4 as NodeRollup<br/>Handler (A4)
    participant Gemini as Gemini API
    participant Limiter as Shared LLM<br/>Limiter (Redis)
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

    PubSub->>A3: draft.updated
    A3->>Bundle: onDraftUpdated<br/>(bundle 生成判断)
    A3->>PubSub: emit bundle.created

    PubSub->>A3: bundle.created
    A3->>Bundle: onBundleCreated<br/>(hierarchy plan 生成)
    Note over Bundle: buildHierarchyPlan<br/>cluster / subcluster 構造決定<br/>MIN_CLAIMS_FOR_CLUSTER=2
    A3->>Limiter: acquirePermit (quality)
    Limiter-->>A3: granted
    A3->>Gemini: bundle 説明文生成
    Gemini-->>A3: description
    A3->>Limiter: releasePermit
    A3->>Store: GCS bundle 書き込み
    A3->>PubSub: emit bundle.described + outline.updated

    PubSub->>A3: outline.updated
    A3->>Bundle: onOutlineUpdated (node 更新)
    A3->>Store: NodeRepository.upsert
    A3->>PubSub: emit topic.node_changed (changedNodeIds 分)

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

```mermaid
flowchart TD
    CALL["callGemini(prompt, validate, options)"]

    PERMIT["acquireLlmPermit\nestimatedInputTokens 計算\n(UTF-8 bytes / 4)"]

    subgraph LUA["Redis Lua Script (atomic)"]
        direction TB
        CLEANUP["ZREMRANGEBYSCORE inflight\n期限切れエントリを削除"]
        CHK_INF{"inflight + 1\n> maxConcurrency?"}
        CHK_IDEM{"requestKey\n既存?"}
        CHK_RPM{"rpm + 1\n> targetRpm?"}
        CHK_TPM{"tpm + tokens\n> targetTpm?"}
        GRANT["SET requestKey EX req_ttl\nINCRBY rpm / tpm\nZADD inflight deadline:requestId\nreturn 1"]
    end

    DENY_INF["return -1\nretryAfterMs = 250ms"]
    DENY_RT["return -2\nretryAfterMs = 次 minute まで"]
    IDEM["return 0\n(idempotent grant)"]

    FETCH["Gemini API 呼び出し"]

    subgraph RELEASE["releaseLlmPermit"]
        DEL["DEL requestKey"]
        ZREM["ZREM inflight requestId"]
        CORRECT["INCRBY tpm\n(actual - reserved)\nactual = promptTokens + candidateTokens"]
    end

    ERROR{"エラー?"}
    RESULT["validate → return parsed"]

    CALL --> PERMIT --> CLEANUP --> CHK_INF
    CHK_INF -->|Yes| DENY_INF
    CHK_INF -->|No| CHK_IDEM
    CHK_IDEM -->|Yes| IDEM
    CHK_IDEM -->|No| CHK_RPM
    CHK_RPM -->|Yes| DENY_RT
    CHK_RPM -->|No| CHK_TPM
    CHK_TPM -->|Yes| DENY_RT
    CHK_TPM -->|No| GRANT

    GRANT --> FETCH
    IDEM --> FETCH

    FETCH --> ERROR
    ERROR -->|timeout / network| RELEASE
    ERROR -->|No| RESULT --> RELEASE

    DENY_INF & DENY_RT --> THROW["TemporaryDependencyError\n→ Pub/Sub retry"]

    style DENY_INF fill:#f88,color:#000
    style DENY_RT fill:#f88,color:#000
    style THROW fill:#f88,color:#000
    style GRANT fill:#8f8,color:#000
    style IDEM fill:#8f8,color:#000
```

---

## 5. Review Inbox 振り分け条件

```mermaid
flowchart TD
    RESOLVE["TopicResolverService.resolve()"]

    COND1{"confidence < 0.75?"}
    COND2{"scoreGap < 0.15?\n(top1 - top2 スコア差)"}

    REVIEW["OrganizeReviewRepository.upsert\nreviewType: topic_resolution_ambiguous\nsourceBatchId / sourceChunkId 保存"]

    PROCEED["topic.resolved を emit\nshouldReview: true を payload に含める"]

    RESOLVE --> COND1
    COND1 -->|Yes| REVIEW
    COND1 -->|No| COND2
    COND2 -->|Yes| REVIEW
    COND2 -->|No| PROCEED
    REVIEW --> PROCEED
```

---

## 6. データモデル / 状態遷移

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
