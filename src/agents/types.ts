import type { EventEnvelope, PubsubAttributes } from "../models/envelope.js";

export type AgentResult = {
  ack: true;
  emittedEvents?: Array<Record<string, string | number>>;
};

export type AgentContext = {
  envelope: EventEnvelope;
  attributes: PubsubAttributes;
};

export interface AgentHandler {
  readonly eventType: string;
  handle(context: AgentContext): Promise<AgentResult>;
}
