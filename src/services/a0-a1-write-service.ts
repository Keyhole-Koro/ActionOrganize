import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { InputRepository } from "../repositories/input-repository.js";
import { InputProgressRepository } from "../repositories/input-progress-repository.js";
import { AtomRepository } from "../repositories/atom-repository.js";
import { readFromGcsUri, readMarkdown, writeMarkdown } from "../core/storage.js";

import { callGemini } from "../lib/gemini-client.js";
import { logger } from "../lib/logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

type AtomKind = "fact" | "definition" | "relation" | "opinion" | "temporal";
const VALID_KINDS: AtomKind[] = ["fact", "definition", "relation", "opinion", "temporal"];
const VALID_CONFIDENCE_BUCKETS = [0.95, 0.8, 0.6, 0.4, 0.2];

interface ClaimCandidate {
  index: number;
  text: string;
  sourceSpan: string;
}

interface NormalizedAtom {
  title: string;
  claim: string;
  kind: AtomKind;
  confidence: number;
  reject: boolean;
  rejectReason?: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class A0A1WriteService {
  private readonly inputRepository = new InputRepository();
  private readonly inputProgressRepository = new InputProgressRepository();
  private readonly atomRepository = new AtomRepository();

  private isFirestoreBackend() {
    return env.STATE_BACKEND === "firestore";
  }

  // ── A0 MediaReceived ────────────────────────────────────────────────────

  async onMediaReceived(envelope: EventEnvelope, inputId: string): Promise<string> {
    if (!this.isFirestoreBackend()) {
      return "";
    }

    const contentType =
      typeof envelope.payload.contentType === "string" ? envelope.payload.contentType : "text/plain";
    const rawRef =
      typeof envelope.payload.rawRef === "string" ? envelope.payload.rawRef : undefined;

    await this.inputRepository.upsert({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "received",
      contentType,
      rawRef,
    });

    // Extract text from the uploaded raw file
    let sourceText = "";
    if (rawRef) {
      try {
        if (contentType.startsWith("text/")) {
          // Plain text: read bytes directly from upload bucket
          const raw = await readFromGcsUri(rawRef);
          sourceText = raw.toString("utf-8");
          logger.info({ inputId, contentType }, "A0: read source text from GCS upload bucket");
        } else {
          // Binary (PDF, image, etc.) or unknown (octet-stream):
          // In local dev, Gemini cannot read from emulator GCS URIs.
          // We first attempt to read as raw text regardless of content type.
          try {
            const raw = await readFromGcsUri(rawRef);
            const possibleText = raw.toString("utf-8");
            // Simple heuristic to check if it's actually text
            if (possibleText.length > 0 && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(possibleText.slice(0, 512))) {
              sourceText = possibleText;
              logger.info({ inputId, contentType }, "A0: read as raw text (heuristic match)");
            }
          } catch (e) {
            // ignore and proceed to Gemini
          }

          if (!sourceText) {
            // delegate to Gemini for text extraction
            sourceText = await this.extractTextFromFileWithGemini(rawRef, contentType);
            logger.info({ inputId, contentType }, "A0: extracted source text via Gemini");
          }
        }
      } catch (error) {
        logger.error({ error, inputId, rawRef }, "A0: failed to extract source text");
      }
    }

    if (sourceText.trim().length > 0) {
      await writeMarkdown(`mind/inputs/${inputId}.md`, sourceText);
    }

    await this.inputProgressRepository.advance({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "extracting",
      currentPhase: "A0_MEDIA_INTERPRETER",
      lastEventType: envelope.type,
      traceId: envelope.traceId,
    });

    return sourceText;
  }

  private async extractTextFromFileWithGemini(fileUri: string, mimeType: string): Promise<string> {
    const prompt = "Extract all text content from this file and return it as plain text. Do not add any commentary, formatting, or JSON — just the raw text content.";
    
    let filePart: GeminiFilePart;
    if (env.STORAGE_EMULATOR_HOST) {
      // Local dev: download and send as inline data
      const data = await readFromGcsUri(fileUri);
      filePart = { data, mimeType };
    } else {
      // Production: send file URI
      filePart = { fileUri, mimeType };
    }

    const result = await callGemini(
      prompt,
      (v) => {
        if (typeof v === "string") return v;
        throw new Error("expected string");
      },
      { modelTier: "fast", jsonMode: false, timeoutMs: 60_000 },
      [filePart],
    );
    return result.raw;
  }

  // ── A1 InputReceived (Gemini-driven atom extraction) ───────────────────

  async onInputReceived(envelope: EventEnvelope, inputId: string): Promise<string[]> {
    if (!this.isFirestoreBackend()) {
      return [];
    }

    logger.info({ inputId, eventType: envelope.type }, "A1: processing input received event");

    await this.inputProgressRepository.advance({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "atomizing",
      currentPhase: "A1_ATOMIZER",
      lastEventType: envelope.type,
      traceId: envelope.traceId,
    });

    // ── Resolve source text ───────────────────────────────────────────────
    let sourceText = typeof envelope.payload.text === "string" ? envelope.payload.text : "";

    if (sourceText.trim().length === 0) {
      // Fallback: try to read from GCS if payload is empty
      try {
        sourceText = await readMarkdown(`mind/inputs/${inputId}.md`);
        logger.info({ inputId }, "A1: resolved source text from GCS");
      } catch (error) {
        throw new Error(
          `input.received payload.text is missing and GCS fallback failed (inputId=${inputId}). Original error: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    }

    if (sourceText.trim().length === 0) {
      throw new Error(`input.received source text is empty (inputId=${inputId})`);
    }

    // ── Gemini-driven extraction and normalization ────────────────────────
    // We no longer use deterministic splitIntoClaims. 
    // Gemini identifies boundaries and content units based on semantic meaning.
    const normalizedAtoms = await this.extractAndNormalizeWithGemini(sourceText);
    logger.info(
      {
        inputId,
        total: normalizedAtoms.length,
        rejected: normalizedAtoms.filter((a) => a.reject).length,
      },
      "A1: Gemini extraction and normalization complete",
    );

    // ── Filter rejected ───────────────────────────────────────────────────
    const acceptedAtoms = normalizedAtoms.filter((a) => !a.reject);

    // ── Generate deterministic atom IDs ───────────────────────────────────
    const atomEntries = acceptedAtoms.map((atom, index) => {
      const atomId = generateAtomId(envelope.topicId, inputId, index, atom.claim);
      return { atomId, atom, index };
    });

    // ── Persist to Firestore ──────────────────────────────────────────────
    await this.inputRepository.upsert({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "extracted",
      contentType:
        typeof envelope.payload.contentType === "string" ? envelope.payload.contentType : "text/plain",
      extractedRef:
        typeof envelope.payload.extractedRef === "string" ? envelope.payload.extractedRef : undefined,
    });

    await Promise.all(
      atomEntries.map(({ atomId, atom, index }) =>
        this.atomRepository.upsert({
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          atomId,
          sourceInputId: inputId,
          claimIndex: index,
          title: atom.title,
          claim: atom.claim,
          kind: atom.kind,
          confidence: atom.confidence,
        }),
      ),
    );

    // ── Write atom files to GCS ───────────────────────────────────────────
    try {
      await Promise.all(
        atomEntries.map(({ atomId, atom }) =>
          writeMarkdown(
            `mind/atoms/${atomId}.md`,
            `# ${atom.title}\n\n${atom.claim}\n\nkind: ${atom.kind}\nconfidence: ${atom.confidence}`,
          ),
        ),
      );
    } catch (error) {
      logger.warn({ error, inputId }, "failed to write atoms to GCS, continuing");
    }

    // ── Update handler's atom IDs for downstream ──────────────────────────
    await this.inputProgressRepository.advance({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "resolving_topic",
      currentPhase: "A1_ATOMIZER",
      lastEventType: "atom.created",
      traceId: envelope.traceId,
    });

    return atomEntries.map(({ atomId }) => atomId);
  }

  // ── TopicResolved ───────────────────────────────────────────────────────

  async onTopicResolved(
    envelope: EventEnvelope,
    inputId: string,
    resolvedTopicId: string,
    resolutionMode: string,
  ) {
    if (!this.isFirestoreBackend()) {
      return;
    }

    const sourceTopicId = `topic:${inputId}`;

    await this.inputProgressRepository.advanceMany({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "updating_draft",
      currentPhase: "TOPIC_RESOLVER",
      lastEventType: envelope.type,
      traceId: envelope.traceId,
      resolvedTopicId,
      resolutionMode,
    }, [envelope.topicId, sourceTopicId]);
  }

  // ── Gemini extraction and normalization ─────────────────────────────────

  private async extractAndNormalizeWithGemini(sourceText: string): Promise<NormalizedAtom[]> {
    const prompt = buildExtractionAndNormalizationPrompt(sourceText);

    const { parsed } = await callGemini<NormalizedAtom[]>(prompt, (value) => {
      if (!Array.isArray(value)) {
        throw new Error("Expected an array of atoms");
      }
      return value.map((item: Record<string, unknown>, i: number) => {
        if (typeof item.title !== "string" || item.title.trim().length === 0) {
          throw new Error(`Gemini extraction: item[${i}].title is missing or empty`);
        }
        if (typeof item.claim !== "string" || item.claim.trim().length === 0) {
          throw new Error(`Gemini extraction: item[${i}].claim is missing or empty`);
        }
        if (!VALID_KINDS.includes(item.kind as AtomKind)) {
          throw new Error(`Gemini extraction: item[${i}].kind "${item.kind}" is not a valid AtomKind`);
        }
        if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)) {
          throw new Error(`Gemini extraction: item[${i}].confidence is not a number`);
        }
        return {
          title: item.title.slice(0, 120),
          claim: item.claim,
          kind: item.kind as AtomKind,
          confidence: snapToConfidenceBucket(item.confidence),
          reject: item.reject === true,
          rejectReason: typeof item.rejectReason === "string" ? item.rejectReason : undefined,
        };
      });
    }, { modelTier: "fast" });

    return parsed;
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function generateAtomId(topicId: string, inputId: string, candidateIndex: number, claim: string): string {
  const hash = createHash("sha256")
    .update(`${topicId}${inputId}${candidateIndex}${claim}`)
    .digest("hex")
    .slice(0, 16);
  return `atom:${topicId}:${inputId}:${hash}`;
}

function snapToConfidenceBucket(raw: number): number {
  let closest = VALID_CONFIDENCE_BUCKETS[0];
  let minDist = Math.abs(raw - closest);
  for (const bucket of VALID_CONFIDENCE_BUCKETS) {
    const dist = Math.abs(raw - bucket);
    if (dist < minDist) {
      minDist = dist;
      closest = bucket;
    }
  }
  return closest;
}

function buildExtractionAndNormalizationPrompt(sourceText: string): string {
  return `You are a knowledge extraction agent. Analyze the following source text and extract all distinct, meaningful units of information (Atoms). 

For each unit of information, return a JSON array where each element has:
- "title": a short (≤80 chars) descriptive title
- "claim": the normalized, self-contained claim text. It should make sense without the original context.
- "kind": exactly one of "fact", "definition", "relation", "opinion", "temporal"
- "confidence": one of 0.95, 0.8, 0.6, 0.4, 0.2
- "reject": true if this is noise, OCR garbage, or not a meaningful claim
- "rejectReason": string if reject is true

Kind priority:
1. temporal (time-dependent)
2. relation (describes a relationship)
3. definition (defines a concept)
4. opinion (subjective evaluation)
5. fact (verifiable, default)

Source Text:
${sourceText}

Return ONLY a JSON array, no other text.`;
}
