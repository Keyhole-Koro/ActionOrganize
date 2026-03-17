import { env } from "../config/env.js";
import { TemporaryDependencyError } from "../core/errors.js";
import { logger } from "./logger.js";

export interface GeminiOptions {
    /** Timeout in ms. Defaults to 10000. */
    timeoutMs?: number;
    /** Temperature. Defaults to 0. */
    temperature?: number;
    /** If true request JSON output via responseMimeType. Defaults to true. */
    jsonMode?: boolean;
    /** Model tier used for the request. */
    modelTier: "fast" | "quality";
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

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Shared Gemini client for Organize pipeline agents.
 */
export async function callGemini<T = unknown>(
    prompt: string,
    validate: (value: unknown) => T,
    options: GeminiOptions,
): Promise<GeminiResponse<T>> {
    if (mockHandler) {
        return mockHandler(prompt, validate, options);
    }

    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        temperature = 0,
        jsonMode = true,
        modelTier,
    } = options;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const model = modelTier === "quality" ? env.GEMINI_MODEL_QUALITY : env.GEMINI_MODEL_FAST;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_API_KEY}`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                temperature,
                ...(jsonMode ? { responseMimeType: "application/json" } : {}),
            },
        }),
        signal: controller.signal,
    })
        .catch((error) => {
            if (error instanceof Error && error.name === "AbortError") {
                throw new TemporaryDependencyError("Gemini request timed out");
            }
            throw new TemporaryDependencyError(
                `Gemini request failed: ${error instanceof Error ? error.message : "unknown error"}`,
            );
        })
        .finally(() => clearTimeout(timeout));

    if (!response.ok) {
        throw new TemporaryDependencyError(`Gemini request failed with ${response.status}`);
    }

    const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string" || text.length === 0) {
        throw new TemporaryDependencyError("Gemini response was empty");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(extractJson(text));
    } catch {
        throw new TemporaryDependencyError("Gemini response was not valid JSON");
    }

    return { raw: text, parsed: validate(parsed) };
}

function extractJson(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    return text.trim();
}
