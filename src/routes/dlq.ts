import { Router } from "express";
import { logger } from "../lib/logger.js";
import { EventPublisher } from "../services/event-publisher.js";
import { eventEnvelopeSchema } from "../models/envelope.js";
import type { EventEnvelope } from "../models/envelope.js";

export const dlqRouter = Router();

/**
 * DLQ consumer endpoint.
 * Receives messages from `mind-events-dlq` and requeues them to `mind-events`
 * with a new traceId suffix for tracking.
 */
dlqRouter.post("/dlq/replay", async (req, res) => {
    try {
        const body = req.body as {
            message?: {
                data?: string;
                messageId?: string;
            };
        };

        if (!body.message?.data) {
            res.status(400).json({ ok: false, error: "missing message.data" });
            return;
        }

        const decoded = Buffer.from(body.message.data, "base64").toString("utf-8");
        let envelope: EventEnvelope;
        try {
            envelope = eventEnvelopeSchema.parse(JSON.parse(decoded));
        } catch {
            res.status(400).json({ ok: false, error: "invalid envelope" });
            return;
        }

        logger.info(
            {
                type: envelope.type,
                topicId: envelope.topicId,
                workspaceId: envelope.workspaceId,
                originalTraceId: envelope.traceId,
                messageId: body.message.messageId,
            },
            "DLQ: replaying message",
        );

        // Re-emit the event with a new trace suffix
        const publisher = new EventPublisher();
        await publisher.publish({
            sourceEnvelope: {
                ...envelope,
                traceId: `${envelope.traceId}:dlq-replay`,
            },
            result: {
                ack: true,
                emittedEvents: [
                    {
                        type: envelope.type,
                        topicId: envelope.topicId,
                        idempotencyKey: `${envelope.idempotencyKey}:dlq-replay:${Date.now()}`,
                        payload: envelope.payload,
                    },
                ],
            },
        });

        res.status(200).json({ ok: true, replayed: true });
    } catch (error) {
        logger.error({ error }, "DLQ replay failed");
        res.status(500).json({ ok: false, error: "replay failed" });
    }
});
