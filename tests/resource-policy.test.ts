import { describe, it, expect } from "vitest";
import { getLeaseResourceKey } from "../src/core/resource-policy.js";
import type { EventEnvelope } from "../src/models/envelope.js";

function makeEnvelope(
    type: string,
    payload: Record<string, unknown> = {}
): EventEnvelope {
    return {
        schemaVersion: "1",
        type,
        traceId: "trace-1",
        workspaceId: "ws-1",
        topicId: "topic-1",
        idempotencyKey: "idem-1",
        emittedAt: "2026-01-01T00:00:00+00:00",
        payload,
    };
}

describe("getLeaseResourceKey", () => {
    describe("topic-level events", () => {
        const topicEventTypes = [
            "topic.resolved",
            "draft.updated",
            "bundle.created",
            "outline.updated",
            "topic.metrics.updated",
        ];

        for (const type of topicEventTypes) {
            it(`returns topic key for ${type}`, () => {
                const result = getLeaseResourceKey(makeEnvelope(type));
                expect(result).toBe("topic:topic-1");
            });
        }
    });

    describe("node-level events", () => {
        it("returns node key for topic.node_changed with nodeId", () => {
            const result = getLeaseResourceKey(
                makeEnvelope("topic.node_changed", { nodeId: "node-42" })
            );
            expect(result).toBe("node:node-42");
        });

        it("returns node key for node.rollup_requested with nodeId", () => {
            const result = getLeaseResourceKey(
                makeEnvelope("node.rollup_requested", { nodeId: "node-99" })
            );
            expect(result).toBe("node:node-99");
        });

        it("returns null when nodeId is missing", () => {
            const result = getLeaseResourceKey(
                makeEnvelope("topic.node_changed", {})
            );
            expect(result).toBeNull();
        });

        it("returns null when nodeId is empty string", () => {
            const result = getLeaseResourceKey(
                makeEnvelope("topic.node_changed", { nodeId: "" })
            );
            expect(result).toBeNull();
        });

        it("returns null when nodeId is not a string", () => {
            const result = getLeaseResourceKey(
                makeEnvelope("node.rollup_requested", { nodeId: 123 })
            );
            expect(result).toBeNull();
        });
    });

    describe("unknown event types", () => {
        it("returns null for unknown event type", () => {
            expect(getLeaseResourceKey(makeEnvelope("unknown.event"))).toBeNull();
        });

        it("returns null for empty type", () => {
            expect(getLeaseResourceKey(makeEnvelope(""))).toBeNull();
        });
    });
});
