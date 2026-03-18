import { Router } from "express";
import { ZodError } from "zod";
import { AppError, DuplicateEventError, EventInProgressError, InvalidEventError } from "../core/errors.js";
import { decodePushEvent } from "../core/pubsub.js";
import { logger } from "../lib/logger.js";
import { EventProcessor } from "../services/event-processor.js";

export const eventsRouter = Router();
const eventProcessor = new EventProcessor();

eventsRouter.post("/events", async (req, res) => {
  try {
    const decoded = decodePushEvent(req.body);
    const result = await eventProcessor.process(decoded);

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

    if (error instanceof DuplicateEventError) {
      logger.info({ error: error.message, stage: error.stage }, "duplicate event skipped");
      res.status(200).json({
        ok: true,
        ack: true,
        duplicate: true,
        stage: error.stage,
      });
      return;
    }

    if (error instanceof AppError) {
      const logFn = error instanceof EventInProgressError ? logger.warn.bind(logger) : logger.error.bind(logger);
      logFn(
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

    logger.error({ 
      error: error instanceof Error ? error.message : "unknown",
      stack: error instanceof Error ? error.stack : undefined,
      type: error instanceof Error ? error.constructor.name : typeof error
    }, "unexpected event processing failure");
    res.status(503).json({
      ok: false,
      ack: false,
      retryable: true,
      stage: "PROCESS_AGENT",
      error: error instanceof Error ? error.message : "unknown",
    });
  }
});
