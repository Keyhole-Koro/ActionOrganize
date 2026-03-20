import { EventProcessor } from "../src/services/event-processor.js";
import type { EventEnvelope } from "../src/models/envelope.js";
import { setGeminiMockHandler } from "../src/lib/gemini-client.js";

// --- シミュレーション用の高度な AI モック ---
setGeminiMockHandler(async (prompt, validate) => {
  if (prompt.includes("knowledge extraction agent")) {
    return {
      raw: "",
      parsed: validate([
        { title: "高速鉄道の優先順位", claim: "都市間を結ぶ高速鉄道プロジェクトが国内便に代わる手段として優先されている。", kind: "fact", confidence: 0.95, reject: false },
        { title: "マイクロモビリティの普及", claim: "電動スクーターやシェアサイクルがラストワンマイルの接続性を解決している。", kind: "fact", confidence: 0.9, reject: false },
        { title: "15分都市の概念", claim: "徒歩や自転車で全てのサービスにアクセスできる15分都市が都市計画に統合されている。", kind: "definition", confidence: 0.95, reject: false },
        { title: "スマートグリッド投資", claim: "電動モビリティの負荷を支えるため、スマートグリッドへの多大な投資が必要である。", kind: "relation", confidence: 0.85, reject: false },
        { title: "プライバシーの懸念", claim: "交通管理用のセンサー配備に伴い、データプライバシーの問題が浮上している。", kind: "opinion", confidence: 0.8, reject: false }
      ])
    };
  } else if (prompt.includes("topic resolver")) {
    return {
      raw: "",
      parsed: validate({
        decision: "create_new",
        confidence: 0.95,
        reason: "都市計画、交通インフラ、テクノロジーの交差点を包括的に扱っており、新規の『持続可能な都市交通』トピックとして定義するのが適切。"
      })
    };
  } else if (prompt.includes("knowledge graph architect")) {
    const data: Record<string, any> = {};
    const nodeIds = prompt.match(/node:[^",\s]+/g) || [];
    nodeIds.forEach((id, i) => {
      const cleanId = id.replace(/"/g, '');
      if (i === 0) data[cleanId] = { clusterTitle: "都市インフラ", subclusterTitle: "広域交通" };
      else if (i === 1) data[cleanId] = { clusterTitle: "モビリティ", subclusterTitle: "ラストワンマイル" };
      else if (i === 2) data[cleanId] = { clusterTitle: "都市インフラ", subclusterTitle: "都市計画" };
      else if (i === 3) data[cleanId] = { clusterTitle: "テクノロジー", subclusterTitle: "エネルギー" };
      else data[cleanId] = { clusterTitle: "テクノロジー", subclusterTitle: "ガバナンス" };
    });
    return { raw: "", parsed: validate(data) };
  } else if (prompt.includes("knowledge pipeline documentation agent")) {
    return { raw: "", parsed: validate({ html: "<h1>都市交通の最新動向</h1><p>このバンドルでは、インフラ、モビリティ、テクノロジーの3つの視点から都市の進化をまとめています。</p>" }) };
  } else if (prompt.includes("knowledge summarizer")) {
    return { raw: "", parsed: validate({ 
      html: "<section><h2>都市インフラの概要</h2><p>高速鉄道と15分都市の概念を中心とした、物理的な都市設計の変革を扱います。</p></section>", 
      contextSummary: "都市インフラ層：広域交通（鉄道）と地域計画（15分都市）の統合。" 
    }) };
  }
  return { raw: "", parsed: validate({ html: "<div>Simulated</div>", contextSummary: "Summary" }) };
});

async function main() {
  process.env.STATE_BACKEND = "memory";
  process.env.PUBSUB_PUBLISH_ENABLED = "false";
  process.env.GOOGLE_CLOUD_PROJECT = "complex-sim";
  const processor = new EventProcessor();

  const sourceText = "近代的な都市交通はパラダイムシフトを迎えています。都市間を結ぶ高速鉄道プロジェクトが優先され、国内便への依存を減らしています。一方で、「ラストワンマイル」の接続性は、電動スクーターやシェアサイクルなどのマイクロモビリティで解決されつつあります。都市計画には「15分都市」の概念が取り入れられ、徒歩圏内にサービスが集約されています。これにはスマートグリッドへの多大な投資が必要であり、交通管理センサーによるプライバシーの懸念も浮上しています。";

  const initialEnv: EventEnvelope = {
    schemaVersion: "1.0",
    type: "media.received",
    traceId: "sim-trace-1",
    workspaceId: "ws-1",
    topicId: "topic-urban-future",
    idempotencyKey: "sim-idem-1",
    emittedAt: new Date().toISOString(),
    payload: { inputId: "input-urban-1", contentType: "text/plain", text: sourceText }
  };

  console.log("--- Pipeline Simulation Start ---\n");
  
  let currentEvents: any[] = [{ type: initialEnv.type, topicId: initialEnv.topicId, payload: initialEnv.payload, idempotencyKey: initialEnv.idempotencyKey }];
  let iterations = 0;

  while (currentEvents.length > 0 && iterations < 50) {
      iterations++;
      const event = currentEvents.shift()!;
      const env: EventEnvelope = {
          schemaVersion: "1.0",
          type: event.type,
          traceId: "sim-trace-1",
          workspaceId: "ws-1",
          topicId: event.topicId || "topic-urban-future",
          idempotencyKey: event.idempotencyKey || `idem-${Date.now()}-${Math.random()}`,
          emittedAt: new Date().toISOString(),
          payload: event.payload
      };
      await processor.process({ envelope: env, push: { message: { messageId: "sim-msg" } } } as any);
      if (iterations % 5 === 0) console.log(`Step ${iterations}: Processing ${event.type}...`);
  }

  console.log("\n--- Final Structured Output (Simulation) ---\n");
  
  // 最終的な「ドキュメント」のイメージを表示
  console.log("【生成されたアウトライン (Markdown)】");
  console.log("# Map topic-urban-future\n- node:topic-urban-future:root\n  - 都市インフラ (cluster)\n    - 広域交通 (subcluster)\n      - 高速鉄道の優先順位 (claim)\n    - 都市計画 (subcluster)\n      - 15分都市の概念 (claim)\n  - モビリティ (cluster)\n    - ラストワンマイル (subcluster)\n      - マイクロモビリティの普及 (claim)\n  - テクノロジー (cluster)\n    - エネルギー (subcluster)\n      - スマートグリッド投資 (claim)\n    - ガバナンス (subcluster)\n      - プライバシーの懸念 (claim)\n");

  console.log("【生成されたノード・サマリー (HTML)】");
  console.log("<section><h2>都市インフラの概要</h2><p>都市間交通と地域内移動を統合する新しい設計思想...</p></section>");
  
  console.log("\n--- Simulation Finished ---");
}

main().catch(console.error);
