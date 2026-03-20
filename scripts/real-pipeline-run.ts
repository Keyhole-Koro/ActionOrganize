import { EventProcessor } from "../src/services/event-processor.js";
import { resolveRepositories } from "../src/repositories/index.js";
import type { EventEnvelope } from "../src/models/envelope.js";
import { logger } from "../src/lib/logger.js";

async function main() {
  // 環境設定 (Firestoreは使わずメモリ、PubSubはオフ、AIキーはダミー)
  process.env.STATE_BACKEND = "memory";
  process.env.PUBSUB_PUBLISH_ENABLED = "false";
  process.env.GOOGLE_CLOUD_PROJECT = "real-run-project";
  process.env.GOOGLE_API_KEY = "dummy-key"; // 本物があればここでセット
  process.env.GEMINI_MODEL_FAST = "gemini-3-flash";
  process.env.GEMINI_MODEL_QUALITY = "gemini-3-pro";

  const processor = new EventProcessor();

  // 現実的な多めのインプットテキスト
  const sourceText = `持続可能な都市交通：2026年戦略
  1. 都市部での電動バス導入により、二酸化炭素排出量を年間30%削減する。
  2. 充電ステーションの設置場所が不足しており、特に旧市街地での用地確保が最大の課題となっている。
  3. 自動運転技術を活用したデマンド型交通（DRT）の実証実験を、北区で開始する。
  4. 交通データの利活用により渋滞を20%緩和させるが、データの匿名化とプライバシー保護が必須条件である。`;

  const initialEnv: EventEnvelope = {
    schemaVersion: "1.0",
    type: "media.received",
    traceId: "real-trace-123",
    workspaceId: "ws-1",
    topicId: "topic-urban-strategy",
    idempotencyKey: "real-idem-123",
    emittedAt: new Date().toISOString(),
    payload: {
      inputId: "input-urban-strategy",
      contentType: "text/plain",
      text: sourceText
    }
  };

  console.log(">>> [ActionOrganize Pipeline Start]");
  console.log(`Input Text: "${sourceText.slice(0, 100)}..."`);

  let currentEvents: any[] = [{ 
    type: initialEnv.type, 
    topicId: initialEnv.topicId, 
    payload: initialEnv.payload, 
    idempotencyKey: initialEnv.idempotencyKey 
  }];
  
  let loopCount = 0;
  while (currentEvents.length > 0 && loopCount < 20) {
    loopCount++;
    const nextEvent = currentEvents.shift()!;
    console.log(`\n--- Step ${loopCount}: Handling [${nextEvent.type}] ---`);

    const env: EventEnvelope = {
        schemaVersion: "1.0",
        type: nextEvent.type,
        traceId: "real-trace-123",
        workspaceId: "ws-1",
        topicId: nextEvent.topicId || "topic-urban-strategy",
        idempotencyKey: nextEvent.idempotencyKey || `auto-idem-${Date.now()}`,
        emittedAt: new Date().toISOString(),
        payload: nextEvent.payload
    };

    try {
        const result = await processor.process({ 
          envelope: env, 
          push: { message: { messageId: "real-msg" } } 
        } as any);
        
        console.log(`Result: Success! (ACK: ${result.ack})`);
        if (result.emittedEvents && result.emittedEvents.length > 0) {
          console.log(`Emitted: [${result.emittedEvents.map(e => e.type).join(", ")}]`);
          currentEvents.push(...result.emittedEvents);
        } else {
          console.log("Terminal step.");
        }
    } catch (err: any) {
        console.error(`!!! FAILED at [${nextEvent.type}] !!!`);
        console.error(`Reason: ${err.message}`);
        // 400エラーが出ることで、ヒューリスティクスが消え「AIが必須になった」ことが証明されます。
        break;
    }
  }

  console.log("\n>>> [ActionOrganize Pipeline Finished]");
}

main().catch(console.error);
