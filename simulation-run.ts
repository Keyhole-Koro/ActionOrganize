import { EventProcessor } from "./src/services/event-processor.js";
import type { EventEnvelope } from "./src/models/envelope.js";
import { setGeminiMockHandler } from "./src/lib/gemini-client.js";

// --- Intelligent Mocking based on Prompt Content ---
setGeminiMockHandler(async (prompt, validate) => {
  let data: any;
  let label: string;

  if (prompt.includes("knowledge extraction agent")) {
    label = "A1 Atomizer";
    data = [
      { title: "EV Popularity", claim: "Electric vehicles are gaining significant market share.", kind: "fact", confidence: 0.95, reject: false },
      { title: "Charging Gaps", claim: "Charging infrastructure is insufficient in rural areas.", kind: "relation", confidence: 0.8, reject: false },
      { title: "Sustainability", claim: "Battery recycling is essential for long-term EV sustainability.", kind: "opinion", confidence: 0.95, reject: false }
    ];
  } else if (prompt.includes("topic resolver")) {
    label = "Topic Resolver";
    data = {
      decision: "create_new",
      confidence: 0.9,
      reason: "The input discusses broad EV infrastructure and sustainability, which doesn't match existing topics."
    };
  } else if (prompt.includes("knowledge graph architect")) {
    label = "Hierarchy Planner";
    data = {};
    // Dynamic IDs are hard to predict, but let's try to match the pattern
    // The planner prompt usually includes a list of nodes.
    const nodeIds = prompt.match(/node:[^",\s]+/g) || [];
    nodeIds.forEach((id, i) => {
      const cleanId = id.replace(/"/g, '');
      data[cleanId] = { 
        clusterTitle: i < 2 ? "Infrastructure & Growth" : "Sustainability & Life Cycle", 
        subclusterTitle: i === 0 ? "Market Adoption" : i === 1 ? "Rural Challenges" : "Recycling" 
      };
    });
  } else {
    label = "Generic (Rollup/Desc)";
    data = { html: "<div>Simulated content</div>", contextSummary: "Simulated summary" };
  }

  console.log(`\n[Gemini Mock Call: ${label}]`);
  return { raw: JSON.stringify(data), parsed: validate(data) };
});

async function main() {
  process.env.STATE_BACKEND = "memory";
  process.env.PUBSUB_PUBLISH_ENABLED = "false";
  process.env.GOOGLE_CLOUD_PROJECT = "simulation-project";

  const processor = new EventProcessor();

  const sourceText = "Electric vehicles (EVs) are growing in popularity. However, charging infrastructure remains a challenge in rural areas. Battery recycling is another critical topic for sustainability.";

  const initialEnv: EventEnvelope = {
    schemaVersion: "1.0",
    type: "media.received",
    traceId: "sim-trace-1",
    workspaceId: "ws-1",
    topicId: "topic-ev-1",
    idempotencyKey: "sim-idem-1",
    emittedAt: new Date().toISOString(),
    payload: {
      inputId: "ev-input-1",
      contentType: "text/plain",
      text: sourceText
    }
  };

  console.log("Starting Simulation with Source Text:", sourceText);
  
  let currentEvents: any[] = [{ type: initialEnv.type, topicId: initialEnv.topicId, payload: initialEnv.payload, idempotencyKey: initialEnv.idempotencyKey }];
  let iterations = 0;

  while (currentEvents.length > 0 && iterations < 40) {
      iterations++;
      const event = currentEvents.shift()!;
      console.log(`\n>>> Handling Event: ${event.type}`);

      const env: EventEnvelope = {
          schemaVersion: "1.0",
          type: event.type,
          traceId: "sim-trace-1",
          workspaceId: "ws-1",
          topicId: event.topicId || "topic-ev-1",
          idempotencyKey: event.idempotencyKey || `idem-${Date.now()}-${Math.random()}`,
          emittedAt: new Date().toISOString(),
          payload: event.payload
      };

      try {
          const result = await processor.process({ envelope: env, push: { message: { messageId: "sim-msg" } } } as any);
          if (result.emittedEvents) {
              currentEvents.push(...result.emittedEvents);
          }
      } catch (err) {
          console.error("Error in simulation:", err);
          break;
      }
  }

  console.log("\n--- Simulation Complete ---");
}

main().catch(console.error);
