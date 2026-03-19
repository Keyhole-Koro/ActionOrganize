import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { TemporaryDependencyError } from "../core/errors.js";
import {
    acquireLlmPermit,
    estimateTokens,
    releaseLlmPermit,
} from "./llm-limiter.js";
import { logger } from "./logger.js";

export interface GeminiOptions {
    /** Timeout in ms. Defaults to DEFAULT_TIMEOUT_MS (5 min). */
    timeoutMs?: number;
    /** Temperature. Defaults to 0. */
    temperature?: number;
    /** If true request JSON output via responseMimeType. Defaults to true. */
    jsonMode?: boolean;
    /** Model tier used for the request. */
    modelTier: "fast" | "quality";
    /** Optional stable request identifier for limiter / logs. */
    requestId?: string;
    /** Reserved output tokens for limiter accounting. Defaults to 512. */
    reservedOutputTokens?: number;
}

export interface GeminiFilePart {
    data: Buffer;
    mimeType: string;
}

export interface GeminiResponse<T = unknown> {
    raw: string;
    parsed: T;
}

export type GeminiMockHandler = (
    prompt: string,
    validate: (value: unknown) => any,
    options: GeminiOptions,
) => Promise<GeminiResponse<any>>;

let mockHandler: GeminiMockHandler | null = null;

export function setGeminiMockHandler(handler: GeminiMockHandler | null) {
    mockHandler = handler;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes default to match Gemini API latency
const DEFAULT_RESERVED_OUTPUT_TOKENS = 512;

// Circuit breaker: after a quality-model 429, use fast model for QUALITY_FALLBACK_DURATION_MS
const QUALITY_FALLBACK_DURATION_MS = 60 * 60 * 1000; // 1 hour
let qualityModelExhaustedAt: number | null = null;

function isQualityModelCircuitOpen(): boolean {
    if (qualityModelExhaustedAt === null) return false;
    if (Date.now() - qualityModelExhaustedAt < QUALITY_FALLBACK_DURATION_MS) return true;
    qualityModelExhaustedAt = null; // reset after 1 hour
    return false;
}

/**
 * Shared Gemini client for Organize pipeline agents.
 */
export async function callGemini<T = unknown>(
    prompt: string,
    validate: (value: unknown) => T,
    options: GeminiOptions,
    fileParts?: GeminiFilePart[],
): Promise<GeminiResponse<T>> {
    if (mockHandler) {
        return mockHandler(prompt, validate, options);
    }

    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        temperature = 0,
        jsonMode = true,
        modelTier,
        reservedOutputTokens = DEFAULT_RESERVED_OUTPUT_TOKENS,
    } = options;

    // Circuit breaker: if quality model was quota-exhausted recently, use fast model directly
    const effectiveTier = (modelTier === "quality" && isQualityModelCircuitOpen()) ? "fast" : modelTier;
    if (effectiveTier !== modelTier) {
        logger.info("quality model circuit open, using fast model directly");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const model = effectiveTier === "quality" ? env.GEMINI_MODEL_QUALITY : env.GEMINI_MODEL_FAST;
    const requestId = options.requestId ?? `gemini:${randomUUID()}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_API_KEY}`;
    const estimatedInputTokens = estimateTokens(prompt) +
        (fileParts?.reduce((total, filePart) => total + Math.max(1, Math.ceil(filePart.data.length / 4)), 0) ?? 0);

    const acquireStartedAt = Date.now();
    const permit = await acquireLlmPermit({
        model,
        requestId,
        estimatedInputTokens,
        reservedOutputTokens,
    });
    const permitWaitMs = Date.now() - acquireStartedAt;

    if (!permit.granted) {
        throw new TemporaryDependencyError(
            `Gemini permit denied for ${model}; retry after ${permit.retryAfterMs ?? 0}ms`,
        );
    }

    const parts: unknown[] = [
        ...(fileParts ?? []).map((f) => ({
            inlineData: { data: f.data.toString("base64"), mimeType: f.mimeType },
        })),
        { text: prompt },
    ];

    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
                temperature,
                ...(jsonMode ? { responseMimeType: "application/json" } : {}),
            },
        }),
        signal: controller.signal,
    })
        .catch(async (error) => {
            await releaseLlmPermit({
                model,
                requestId,
                status: error instanceof Error && error.name === "AbortError" ? "timeout" : "error",
            });
            if (error instanceof Error && error.name === "AbortError") {
                throw new TemporaryDependencyError("Gemini request timed out");
            }
            throw new TemporaryDependencyError(
                `Gemini request failed: ${error instanceof Error ? error.message : "unknown error"}`,
            );
        })
        .finally(() => clearTimeout(timeout));

    if (!response.ok) {
        const errorBody = await response.text();
        await releaseLlmPermit({
            model,
            requestId,
            status: response.status === 429 ? "rate_limited" : "error",
        });
        // Fallback: if quality model is quota-exhausted (429), open circuit and retry with fast model
        if (response.status === 429 && effectiveTier === "quality") {
            qualityModelExhaustedAt = Date.now();
            logger.warn({ model }, "quality model quota exhausted (429), opening circuit breaker for 1h, falling back to fast model");
            return callGemini(prompt, validate, { ...options, modelTier: "fast" }, fileParts);
        }
        throw new TemporaryDependencyError(`Gemini request failed with ${response.status}: ${errorBody}`);
    }

    let data: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
        };
    };
    let text: string;
    let parsed: unknown;

    try {
        data = (await response.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
            };
        };

        const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof candidateText !== "string" || candidateText.length === 0) {
            throw new TemporaryDependencyError("Gemini response was empty");
        }
        text = candidateText;

        if (jsonMode) {
            parsed = JSON.parse(extractJson(text));
        } else {
            parsed = text;
        }
    } catch (error) {
        await releaseLlmPermit({
            model,
            requestId,
            status: "error",
        });
        if (error instanceof TemporaryDependencyError) {
            throw error;
        }
        throw new TemporaryDependencyError("Gemini response was not valid JSON");
    }

    const validated = validate(parsed);

    await releaseLlmPermit({
        model,
        requestId,
        actualInputTokens: data.usageMetadata?.promptTokenCount,
        actualOutputTokens: data.usageMetadata?.candidatesTokenCount,
        status: "ok",
    });

    logger.info(
        {
            model,
            requestId,
            estimatedInputTokens,
            reservedOutputTokens,
            permitWaitMs,
        },
        "gemini request completed",
    );

    return { raw: text, parsed: validated };
}

function extractJson(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    return text.trim();
}
