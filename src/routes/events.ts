import { Router } from "express";
import { ZodError } from "zod";
import { getAgentHandler } from "../agents/registry.js";
import { AppError, InvalidEventError } from "../core/errors.js";
import { decodePushEvent } from "../core/pubsub.js";
import { logger } from "../lib/logger.js";

export const eventsRouter = Router();

eventsRouter.post("/events", async (req, res) => {
  try {
    const decoded = decodePushEvent(req.body);
    const handler = getAgentHandler(decoded.envelope.type);
    const result = await handler.handle({
      envelope: decoded.envelope,
      attributes: decoded.attributes,
    });

    logger.info(
      {
        traceId: decoded.envelope.traceId,
        workspaceId: decoded.envelope.workspaceId,
        topicId: decoded.envelope.topicId,
        idempotencyKey: decoded.envelope.idempotencyKey,
        type: decoded.envelope.type,
        messageId: decoded.push.message.messageId,
        emittedEvents: result.emittedEvents,
      },
      "event processed",
    );

    res.status(200).json({
      ok: true,
      ack: result.ack,
      type: decoded.envelope.type,
      traceId: decoded.envelope.traceId,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      logger.warn({ issues: error.issues }, "event validation failed");
      res.status(200).json({
        ok: false,
        ack: true,
        error: "INVALID_ARGUMENT",
        stage: "VALIDATE_EVENT",
      });
      return;
    }

    if (error instanceof InvalidEventError) {
      logger.warn({ error: error.message, stage: error.stage }, "invalid event payload");
      res.status(200).json({
        ok: false,
        ack: true,
        error: "INVALID_ARGUMENT",
        stage: error.stage,
      });
      return;
    }

    if (error instanceof AppError) {
      logger.error(
        {
          error: error.message,
          retryable: error.retryable,
          stage: error.stage,
        },
        "event processing failed",
      );
      res.status(error.statusCode).json({
        ok: false,
        ack: false,
        retryable: error.retryable,
        stage: error.stage,
      });
      return;
    }

    logger.error({ error }, "unexpected event processing failure");
    res.status(503).json({
      ok: false,
      ack: false,
      retryable: true,
      stage: "PROCESS_AGENT",
    });
  }
});
