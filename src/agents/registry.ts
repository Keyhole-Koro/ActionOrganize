import { UnknownEventTypeError } from "../core/errors.js";
import { pipelineHandlers } from "./handlers/pipeline-handlers.js";
import type { AgentHandler } from "./types.js";

const handlers = new Map<string, AgentHandler>(
  pipelineHandlers.map((handler) => [handler.eventType, handler]),
);

export function getAgentHandler(eventType: string): AgentHandler {
  const handler = handlers.get(eventType);
  if (!handler) {
    throw new UnknownEventTypeError(eventType);
  }
  return handler;
}

export function listSupportedEventTypes(): string[] {
  return [...handlers.keys()];
}
