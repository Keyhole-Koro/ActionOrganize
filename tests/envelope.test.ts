import { describe, it, expect } from "vitest";
import {
    eventEnvelopeSchema,
    pubsubAttributesSchema,
    pubsubPushMessageSchema,
} from "../src/models/envelope.js";

describe("eventEnvelopeSchema", () => {
    const validEnvelope = {
        schemaVersion: "1",
        type: "topic.resolved",
        traceId: "trace-1",
        workspaceId: "ws-1",
        topicId: "topic-1",
        idempotencyKey: "idem-1",
        emittedAt: "2026-01-01T00:00:00+00:00",
        payload: { nodeId: "n1" },
    };

    it("accepts valid envelope", () => {
        const result = eventEnvelopeSchema.safeParse(validEnvelope);
        expect(result.success).toBe(true);
    });

    it("accepts optional uid", () => {
        const result = eventEnvelopeSchema.safeParse({
            ...validEnvelope,
            uid: "user-1",
        });
        expect(result.success).toBe(true);
    });

    it("rejects missing schemaVersion", () => {
        const { schemaVersion, ...rest } = validEnvelope;
        const result = eventEnvelopeSchema.safeParse(rest);
        expect(result.success).toBe(false);
    });

    it("rejects empty type", () => {
        const result = eventEnvelopeSchema.safeParse({
            ...validEnvelope,
            type: "",
        });
        expect(result.success).toBe(false);
    });

    it("rejects missing topicId", () => {
        const { topicId, ...rest } = validEnvelope;
        const result = eventEnvelopeSchema.safeParse(rest);
        expect(result.success).toBe(false);
    });

    it("rejects missing idempotencyKey", () => {
        const { idempotencyKey, ...rest } = validEnvelope;
        const result = eventEnvelopeSchema.safeParse(rest);
        expect(result.success).toBe(false);
    });

    it("rejects invalid emittedAt format", () => {
        const result = eventEnvelopeSchema.safeParse({
            ...validEnvelope,
            emittedAt: "not-a-date",
        });
        expect(result.success).toBe(false);
    });

    it("rejects missing traceId", () => {
        const { traceId, ...rest } = validEnvelope;
        const result = eventEnvelopeSchema.safeParse(rest);
        expect(result.success).toBe(false);
    });
});

describe("pubsubAttributesSchema", () => {
    it("accepts minimal valid attributes", () => {
        const result = pubsubAttributesSchema.safeParse({
            type: "topic.resolved",
            schemaVersion: "1",
            workspaceId: "ws-1",
            topicId: "topic-1",
        });
        expect(result.success).toBe(true);
    });

    it("accepts all optional fields", () => {
        const result = pubsubAttributesSchema.safeParse({
            type: "node.rollup_requested",
            schemaVersion: "1",
            workspaceId: "ws-1",
            topicId: "topic-1",
            nodeId: "n1",
            inputId: "in1",
            bundleId: "b1",
            draftVersion: "v1",
            outlineVersion: "v2",
        });
        expect(result.success).toBe(true);
    });

    it("rejects missing required type", () => {
        const result = pubsubAttributesSchema.safeParse({
            schemaVersion: "1",
            workspaceId: "ws-1",
            topicId: "topic-1",
        });
        expect(result.success).toBe(false);
    });
});

describe("pubsubPushMessageSchema", () => {
    it("accepts valid push message", () => {
        const result = pubsubPushMessageSchema.safeParse({
            message: {
                data: "eyJ0ZXN0IjogdHJ1ZX0=",
                messageId: "msg-1",
                attributes: { type: "topic.resolved" },
            },
        });
        expect(result.success).toBe(true);
    });

    it("rejects missing data", () => {
        const result = pubsubPushMessageSchema.safeParse({
            message: {
                messageId: "msg-1",
            },
        });
        expect(result.success).toBe(false);
    });

    it("rejects empty data string", () => {
        const result = pubsubPushMessageSchema.safeParse({
            message: {
                data: "",
            },
        });
        expect(result.success).toBe(false);
    });

    it("defaults attributes to empty object", () => {
        const result = pubsubPushMessageSchema.safeParse({
            message: {
                data: "dGVzdA==",
            },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.message.attributes).toEqual({});
        }
    });
});
