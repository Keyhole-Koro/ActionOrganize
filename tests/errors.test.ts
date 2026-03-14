import { describe, it, expect } from "vitest";
import {
    AppError,
    InvalidEventError,
    UnknownEventTypeError,
    TemporaryDependencyError,
    DuplicateEventError,
} from "../src/core/errors.js";

describe("AppError", () => {
    it("stores statusCode, retryable, stage", () => {
        const err = new AppError("test", {
            statusCode: 500,
            retryable: true,
            stage: "TEST",
        });
        expect(err.message).toBe("test");
        expect(err.statusCode).toBe(500);
        expect(err.retryable).toBe(true);
        expect(err.stage).toBe("TEST");
        expect(err.name).toBe("AppError");
    });

    it("is an instance of Error", () => {
        const err = new AppError("test", {
            statusCode: 400,
            retryable: false,
            stage: "X",
        });
        expect(err).toBeInstanceOf(Error);
    });
});

describe("InvalidEventError", () => {
    it("has correct defaults", () => {
        const err = new InvalidEventError("bad payload");
        expect(err.statusCode).toBe(200);
        expect(err.retryable).toBe(false);
        expect(err.stage).toBe("VALIDATE_EVENT");
        expect(err.name).toBe("InvalidEventError");
        expect(err.message).toBe("bad payload");
    });

    it("is an instance of AppError", () => {
        expect(new InvalidEventError("x")).toBeInstanceOf(AppError);
    });
});

describe("UnknownEventTypeError", () => {
    it("formats message with event type", () => {
        const err = new UnknownEventTypeError("weird.event");
        expect(err.message).toBe("unsupported event type: weird.event");
        expect(err.stage).toBe("PROCESS_AGENT");
        expect(err.retryable).toBe(false);
        expect(err.statusCode).toBe(200);
    });
});

describe("TemporaryDependencyError", () => {
    it("is retryable with 503", () => {
        const err = new TemporaryDependencyError("Firestore down");
        expect(err.statusCode).toBe(503);
        expect(err.retryable).toBe(true);
        expect(err.stage).toBe("PROCESS_AGENT");
    });
});

describe("DuplicateEventError", () => {
    it("is not retryable at idempotency check", () => {
        const err = new DuplicateEventError("already processed");
        expect(err.statusCode).toBe(200);
        expect(err.retryable).toBe(false);
        expect(err.stage).toBe("IDEMPOTENCY_CHECK");
        expect(err.name).toBe("DuplicateEventError");
    });
});
