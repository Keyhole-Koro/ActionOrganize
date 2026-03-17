import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { InputRepository } from "../repositories/input-repository.js";
import { InputProgressRepository } from "../repositories/input-progress-repository.js";
import { AtomRepository } from "../repositories/atom-repository.js";
import type { EventEnvelope } from "../models/envelope.js";
import { callGemini } from "../lib/gemini-client.js";
import { writeMarkdown } from "../lib/gcs-writer.js";
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

  async onMediaReceived(envelope: EventEnvelope, inputId: string) {
    if (!this.isFirestoreBackend()) {
      return;
    }

    await this.inputRepository.upsert({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "received",
      contentType:
        typeof envelope.payload.contentType === "string" ? envelope.payload.contentType : "text/plain",
      rawRef: typeof envelope.payload.rawRef === "string" ? envelope.payload.rawRef : undefined,
    });

    // Write extracted text to GCS
    const extractedText =
      typeof envelope.payload.text === "string" ? envelope.payload.text : "";
    if (extractedText.length > 0) {
      try {
        await writeMarkdown(`mind/inputs/${inputId}.md`, extractedText);
      } catch (error) {
        logger.warn({ error, inputId }, "failed to write input to GCS, continuing");
      }
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
  }

  // ── A1 InputReceived (Gemini-driven atom extraction) ───────────────────

  async onInputReceived(envelope: EventEnvelope, inputId: string): Promise<string[]> {
    if (!this.isFirestoreBackend()) {
      return [];
    }

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
    if (typeof envelope.payload.text !== "string" || envelope.payload.text.trim().length === 0) {
      throw new Error(`input.received payload.text is required but was missing or empty (inputId=${inputId})`);
    }
    const sourceText = envelope.payload.text;

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
