import { EventProcessor } from "./src/services/event-processor.js";
import { resolveRepositories } from "./src/repositories/index.js";
import type { EventEnvelope } from "./src/models/envelope.js";

async function main() {
  const processor = new EventProcessor();

  const env: EventEnvelope = {
    schemaVersion: "1.0",
    type: "media.received",
    traceId: "test-trace-1",
    workspaceId: "test-ws-1",
    topicId: "test-topic-1",
    idempotencyKey: "test-idem-1",
    emittedAt: new Date().toISOString(),
    payload: {
      inputId: "test-input-1",
      contentType: "text/plain",
      claim: "ActionOrganize is a new backend architecture for event-driven information processing.",
    }
  };

  const decoded = {
    envelope: env,
    push: {
      message: {
        data: Buffer.from(JSON.stringify(env)).toString('base64'),
        messageId: "msg-1"
      }
    }
  };

  console.log("Processing event:", env.type);
  const result = await processor.process(decoded as any);
  console.log("Result:", JSON.stringify(result, null, 2));

  let eventsToProcess = result.emittedEvents || [];

  // Limit loop to prevent infinite runs just in case
  let iterations = 0;
  while (eventsToProcess.length > 0 && iterations < 15) {
      iterations++;
      const nextEvent = eventsToProcess.shift()!;
      console.log("\n--- Processing Next Event:", nextEvent.type, "---");

      const nextEnv: EventEnvelope = {
          schemaVersion: "1.0",
          type: nextEvent.type,
          traceId: env.traceId,
          workspaceId: env.workspaceId,
          topicId: nextEvent.topicId || env.topicId,
          idempotencyKey: nextEvent.idempotencyKey || `test-auto-${Date.now()}-${Math.random()}`,
          emittedAt: new Date().toISOString(),
          payload: nextEvent.payload
      };

      try {
          const nextResult = await processor.process({
              envelope: nextEnv,
              push: { message: { messageId: "msg-auto" } }
          } as any);

          console.log("Result:", JSON.stringify(nextResult, null, 2));
          if (nextResult.emittedEvents) {
              eventsToProcess.push(...nextResult.emittedEvents);
          }
      } catch (err: any) {
          console.error("Error processing event:", nextEvent.type, err);
          break;
      }
  }

  console.log("\n--- Pipeline Emulation Finished ---");
}

main().catch(console.error);
