import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { env } from "../config/env.js";

const FIXED_WINDOW_MS = 60_000;
const WINDOW_TTL_SECONDS = 120;
const REQUEST_TTL_MS = 330_000;
const HEADROOM_RATIO = 0.5;

export type PermitStatus = "ok" | "rate_limited" | "timeout" | "error";

export type AcquirePermitRequest = {
  model: string;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  requestId: string;
};

export type AcquirePermitResult = {
  granted: boolean;
  retryAfterMs?: number;
};

export type ReleasePermitRequest = {
  model: string;
  requestId: string;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  status: PermitStatus;
};

type StoredPermit = {
  model: string;
  reservedTokens: number;
};

export interface LlmLimiterBackend {
  acquire(request: AcquirePermitRequest, nowMs: number): Promise<AcquirePermitResult>;
  release(request: ReleasePermitRequest): Promise<void>;
}

type RedisUrlConfig = {
  host: string;
  port: number;
};

let backendOverride: LlmLimiterBackend | null = null;
let redisBackendSingleton: LlmLimiterBackend | null = null;
let testBackendSingleton: LlmLimiterBackend | null = null;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

export function buildGeminiRequestId(prefix = "gemini"): string {
  return `${prefix}:${randomUUID()}`;
}

export function setLlmLimiterBackendForTests(backend: LlmLimiterBackend | null) {
  backendOverride = backend;
}

export async function acquireLlmPermit(request: AcquirePermitRequest): Promise<AcquirePermitResult> {
  return getLimiterBackend().acquire(request, Date.now());
}

export async function releaseLlmPermit(request: ReleasePermitRequest): Promise<void> {
  await getLimiterBackend().release(request);
}

export class InMemoryLlmLimiterBackend implements LlmLimiterBackend {
  private readonly rpmBuckets = new Map<string, number>();
  private readonly tpmBuckets = new Map<string, number>();
  private readonly inflight = new Map<string, number>();
  private readonly requests = new Map<string, StoredPermit>();

  async acquire(request: AcquirePermitRequest, nowMs: number): Promise<AcquirePermitResult> {
    if (this.requests.has(request.requestId)) {
      return { granted: true };
    }

    const minute = getMinuteBucket(nowMs);
    const rpmKey = `${request.model}:${minute}:rpm`;
    const tpmKey = `${request.model}:${minute}:tpm`;
    const reservedTokens = getReservedTokens(request);
    const currentRpm = this.rpmBuckets.get(rpmKey) ?? 0;
    const currentTpm = this.tpmBuckets.get(tpmKey) ?? 0;
    const currentInflight = this.inflight.get(request.model) ?? 0;

    if (currentInflight + 1 > getMaxConcurrency()) {
      return { granted: false, retryAfterMs: 250 };
    }
    if (currentRpm + 1 > getTargetRpm()) {
      return { granted: false, retryAfterMs: getRetryAfterMs(nowMs) };
    }
    if (currentTpm + reservedTokens > getTargetTpm()) {
      return { granted: false, retryAfterMs: getRetryAfterMs(nowMs) };
    }

    this.requests.set(request.requestId, { model: request.model, reservedTokens });
    this.rpmBuckets.set(rpmKey, currentRpm + 1);
    this.tpmBuckets.set(tpmKey, currentTpm + reservedTokens);
    this.inflight.set(request.model, currentInflight + 1);

    return { granted: true };
  }

  async release(request: ReleasePermitRequest): Promise<void> {
    const permit = this.requests.get(request.requestId);
    if (!permit) {
      return;
    }

    this.requests.delete(request.requestId);
    this.inflight.set(permit.model, Math.max(0, (this.inflight.get(permit.model) ?? 1) - 1));

    const actualTotal = getActualTokens(request);
    if (typeof actualTotal !== "number") {
      return;
    }

    const minute = getMinuteBucket(Date.now());
    const tpmKey = `${permit.model}:${minute}:tpm`;
    const current = this.tpmBuckets.get(tpmKey) ?? 0;
    const adjusted = Math.max(0, current - permit.reservedTokens + actualTotal);
    this.tpmBuckets.set(tpmKey, adjusted);
  }
}

class RedisLlmLimiterBackend implements LlmLimiterBackend {
  private readonly client: MinimalRedisClient;

  constructor(url: string) {
    this.client = new MinimalRedisClient(url);
  }

  async acquire(request: AcquirePermitRequest, nowMs: number): Promise<AcquirePermitResult> {
    const requestKey = this.getRequestKey(request.requestId);
    const existingRequest = await this.client.get(requestKey);
    if (existingRequest) {
      return { granted: true };
    }

    const minute = getMinuteBucket(nowMs);
    const rpmKey = this.getRpmKey(request.model, minute);
    const tpmKey = this.getTpmKey(request.model, minute);
    const inflightKey = this.getInflightKey(request.model);
    const reservedTokens = getReservedTokens(request);

    const [rpm, tpm, inflight] = await Promise.all([
      this.client.getInteger(rpmKey),
      this.client.getInteger(tpmKey),
      this.client.getInteger(inflightKey),
    ]);

    if (inflight + 1 > getMaxConcurrency()) {
      return { granted: false, retryAfterMs: 250 };
    }
    if (rpm + 1 > getTargetRpm()) {
      return { granted: false, retryAfterMs: getRetryAfterMs(nowMs) };
    }
    if (tpm + reservedTokens > getTargetTpm()) {
      return { granted: false, retryAfterMs: getRetryAfterMs(nowMs) };
    }

    const stored = await this.client.set(requestKey, JSON.stringify({
      model: request.model,
      reservedTokens,
    }), {
      exSeconds: Math.ceil(REQUEST_TTL_MS / 1000),
      nx: true,
    });

    if (!stored) {
      return { granted: true };
    }

    await Promise.all([
      this.client.incrBy(rpmKey, 1),
      this.client.expire(rpmKey, WINDOW_TTL_SECONDS),
      this.client.incrBy(tpmKey, reservedTokens),
      this.client.expire(tpmKey, WINDOW_TTL_SECONDS),
      this.client.incrBy(inflightKey, 1),
    ]);

    return { granted: true };
  }

  async release(request: ReleasePermitRequest): Promise<void> {
    const requestKey = this.getRequestKey(request.requestId);
    const stored = await this.client.get(requestKey);
    if (!stored) {
      return;
    }

    let permit: StoredPermit | null = null;
    try {
      permit = JSON.parse(stored) as StoredPermit;
    } catch {
      permit = null;
    }

    await this.client.del(requestKey);

    if (permit?.model) {
      const inflightKey = this.getInflightKey(permit.model);
      const inflight = await this.client.incrBy(inflightKey, -1);
      if (inflight < 0) {
        await this.client.set(inflightKey, "0");
      }
    }

    if (!permit) {
      return;
    }

    const actualTotal = getActualTokens(request);
    if (typeof actualTotal !== "number") {
      return;
    }

    const minute = getMinuteBucket(Date.now());
    const tpmKey = this.getTpmKey(permit.model, minute);
    await this.client.incrBy(tpmKey, actualTotal - permit.reservedTokens);
    const nextValue = await this.client.getInteger(tpmKey);
    if (nextValue < 0) {
      await this.client.set(tpmKey, "0");
      await this.client.expire(tpmKey, WINDOW_TTL_SECONDS);
    }
  }

  private getRequestKey(requestId: string) {
    return `llm:request:${requestId}`;
  }

  private getRpmKey(model: string, minute: number) {
    return `llm:permit:${model}:rpm:${minute}`;
  }

  private getTpmKey(model: string, minute: number) {
    return `llm:permit:${model}:tpm:${minute}`;
  }

  private getInflightKey(model: string) {
    return `llm:permit:${model}:inflight`;
  }
}

type SetOptions = {
  exSeconds?: number;
  nx?: boolean;
};

class MinimalRedisClient {
  private readonly config: RedisUrlConfig;

  constructor(url: string) {
    this.config = parseRedisUrl(url);
  }

  async get(key: string): Promise<string | null> {
    const result = await this.sendCommand(["GET", key]);
    return typeof result === "string" ? result : null;
  }

  async getInteger(key: string): Promise<number> {
    const value = await this.get(key);
    if (typeof value !== "string") {
      return 0;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<boolean> {
    const command = ["SET", key, value];
    if (typeof options.exSeconds === "number") {
      command.push("EX", String(options.exSeconds));
    }
    if (options.nx) {
      command.push("NX");
    }
    const result = await this.sendCommand(command);
    return result === "OK";
  }

  async incrBy(key: string, amount: number): Promise<number> {
    const result = await this.sendCommand(["INCRBY", key, String(amount)]);
    if (typeof result !== "number") {
      throw new Error(`unexpected INCRBY result for key ${key}`);
    }
    return result;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.sendCommand(["EXPIRE", key, String(seconds)]);
  }

  async del(key: string): Promise<void> {
    await this.sendCommand(["DEL", key]);
  }

  private async sendCommand(command: string[]): Promise<string | number | null> {
    const socket = new Socket();
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (handler: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        handler();
      };

      socket.once("error", (error) => {
        finish(() => reject(error));
      });

      socket.once("timeout", () => {
        finish(() => reject(new Error("Redis socket timed out")));
      });

      socket.connect(this.config.port, this.config.host, () => {
        socket.write(encodeRedisCommand(command));
      });

      socket.on("data", (chunk) => {
        chunks.push(chunk);
        try {
          const parsed = decodeRedisReply(Buffer.concat(chunks));
          finish(() => resolve(parsed));
        } catch (error) {
          if (error instanceof IncompleteRedisReplyError) {
            return;
          }
          finish(() => reject(error));
        }
      });

      socket.setTimeout(5_000);
    });
  }
}

class IncompleteRedisReplyError extends Error {}

function getLimiterBackend(): LlmLimiterBackend {
  if (backendOverride) {
    return backendOverride;
  }
  if (env.NODE_ENV === "test") {
    if (!testBackendSingleton) {
      testBackendSingleton = new InMemoryLlmLimiterBackend();
    }
    return testBackendSingleton;
  }
  if (!redisBackendSingleton) {
    redisBackendSingleton = new RedisLlmLimiterBackend(env.LLM_LIMITER_REDIS_URL);
  }
  return redisBackendSingleton;
}

function getReservedTokens(request: AcquirePermitRequest): number {
  return Math.max(1, request.estimatedInputTokens) + Math.max(0, request.reservedOutputTokens);
}

function getActualTokens(request: ReleasePermitRequest): number | undefined {
  const input = request.actualInputTokens;
  const output = request.actualOutputTokens;
  if (typeof input !== "number" && typeof output !== "number") {
    return undefined;
  }
  return Math.max(0, input ?? 0) + Math.max(0, output ?? 0);
}

function getTargetRpm(): number {
  return Math.max(1, Math.floor(env.LLM_LIMITER_TARGET_RPM * HEADROOM_RATIO));
}

function getTargetTpm(): number {
  return Math.max(1, Math.floor(env.LLM_LIMITER_TARGET_TPM * HEADROOM_RATIO));
}

function getMaxConcurrency(): number {
  return Math.max(1, Math.floor(env.LLM_LIMITER_MAX_CONCURRENCY * HEADROOM_RATIO));
}

function getRetryAfterMs(nowMs: number): number {
  const retryAfterMs = FIXED_WINDOW_MS - (nowMs % FIXED_WINDOW_MS);
  return Math.max(100, retryAfterMs);
}

function getMinuteBucket(nowMs: number): number {
  return Math.floor(nowMs / FIXED_WINDOW_MS);
}

function parseRedisUrl(value: string): RedisUrlConfig {
  const parsed = new URL(value);
  if (parsed.protocol !== "redis:") {
    throw new Error("LLM_LIMITER_REDIS_URL must use redis://");
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
  };
}

function encodeRedisCommand(command: string[]): string {
  return `*${command.length}\r\n${command.map((part) => `$${Buffer.byteLength(part, "utf8")}\r\n${part}\r\n`).join("")}`;
}

function decodeRedisReply(buffer: Buffer): string | number | null {
  const [result] = parseRedisReply(buffer, 0);
  return result;
}

function parseRedisReply(buffer: Buffer, offset: number): [string | number | null, number] {
  if (offset >= buffer.length) {
    throw new IncompleteRedisReplyError();
  }

  const prefix = String.fromCharCode(buffer[offset]);
  const lineEnd = findLineEnd(buffer, offset + 1);
  const line = buffer.subarray(offset + 1, lineEnd).toString("utf8");
  const nextOffset = lineEnd + 2;

  if (prefix === "+") {
    return [line, nextOffset];
  }
  if (prefix === ":") {
    return [Number.parseInt(line, 10), nextOffset];
  }
  if (prefix === "-") {
    throw new Error(`Redis error: ${line}`);
  }
  if (prefix === "$") {
    const length = Number.parseInt(line, 10);
    if (length === -1) {
      return [null, nextOffset];
    }
    const end = nextOffset + length;
    if (buffer.length < end + 2) {
      throw new IncompleteRedisReplyError();
    }
    return [buffer.subarray(nextOffset, end).toString("utf8"), end + 2];
  }
  if (prefix === "*") {
    const length = Number.parseInt(line, 10);
    let cursor = nextOffset;
    let last: string | number | null = null;
    for (let index = 0; index < length; index += 1) {
      [last, cursor] = parseRedisReply(buffer, cursor);
    }
    return [last, cursor];
  }
  throw new Error(`Unsupported Redis reply prefix: ${prefix}`);
}

function findLineEnd(buffer: Buffer, offset: number): number {
  for (let index = offset; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
      return index;
    }
  }
  throw new IncompleteRedisReplyError();
}
