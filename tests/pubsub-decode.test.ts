import { describe, expect, it } from "vitest";
import { decodePushEvent } from "../src/core/pubsub.js";

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("decodePushEvent", () => {
  it("accepts canonical envelope format", () => {
    const push = {
      message: {
        data: encodeJson({
          schemaVersion: "1",
          type: "input.received",
          traceId: "trace-1",
          workspaceId: "ws-1",
          topicId: "topic-1",
          idempotencyKey: "idem-1",
          emittedAt: "2026-01-01T00:00:00+00:00",
          payload: { inputId: "in-1" },
        }),
        attributes: {
          type: "input.received",
          schemaVersion: "1",
          workspaceId: "ws-1",
          topicId: "topic-1",
          inputId: "in-1",
        },
      },
    };

    const decoded = decodePushEvent(push);
    expect(decoded.envelope.type).toBe("input.received");
    expect(decoded.attributes.topicId).toBe("topic-1");
  });

  it("normalizes legacy Act API message format", () => {
    const push = {
      message: {
        messageId: "msg-1",
        data: encodeJson({
          type: "input.received",
          payload: {
            workspaceId: "ws-1",
            inputId: "in-legacy-1",
            topicId: "topic-legacy-1",
          },
        }),
        attributes: {
          eventType: "input.received",
        },
      },
    };

    const decoded = decodePushEvent(push);

    expect(decoded.envelope).toMatchObject({
      schemaVersion: "1",
      type: "input.received",
      workspaceId: "ws-1",
      topicId: "topic-legacy-1",
      traceId: "legacy:msg-1",
    });
    expect(decoded.attributes).toMatchObject({
      type: "input.received",
      schemaVersion: "1",
      workspaceId: "ws-1",
      topicId: "topic-legacy-1",
      inputId: "in-legacy-1",
    });
  });
});
