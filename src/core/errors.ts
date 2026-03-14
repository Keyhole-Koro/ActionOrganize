export class AppError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly stage: string;

  constructor(message: string, options: { statusCode: number; retryable: boolean; stage: string }) {
    super(message);
    this.name = "AppError";
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
    this.stage = options.stage;
  }
}

export class InvalidEventError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 200, retryable: false, stage: "VALIDATE_EVENT" });
    this.name = "InvalidEventError";
  }
}

export class UnknownEventTypeError extends AppError {
  constructor(type: string) {
    super(`unsupported event type: ${type}`, {
      statusCode: 200,
      retryable: false,
      stage: "PROCESS_AGENT",
    });
    this.name = "UnknownEventTypeError";
  }
}

export class TemporaryDependencyError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 503, retryable: true, stage: "PROCESS_AGENT" });
    this.name = "TemporaryDependencyError";
  }
}
