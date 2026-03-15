import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { InputRepository } from "../repositories/input-repository.js";
import { InputProgressRepository } from "../repositories/input-progress-repository.js";
import { AtomRepository } from "../repositories/atom-repository.js";
import type { EventEnvelope } from "../models/envelope.js";
import { callGemini, MockGeminiError } from "../lib/gemini-client.js";
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

  // ── A1 InputReceived (two-stage atom extraction) ────────────────────────

  async onInputReceived(envelope: EventEnvelope, inputId: string, _previousAtomIds: string[]) {
    if (!this.isFirestoreBackend()) {
      return;
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
    const sourceText =
      typeof envelope.payload.text === "string" && envelope.payload.text.length > 0
        ? envelope.payload.text
        : `Input ${inputId} content`;

    // ── Stage 1: Deterministic claim boundary ─────────────────────────────
    const candidates = splitIntoClaims(sourceText);
    logger.info(
      { inputId, candidateCount: candidates.length },
      "A1: deterministic split complete",
    );

    // ── Stage 2: Gemini normalization ─────────────────────────────────────
    let normalizedAtoms: NormalizedAtom[];
    try {
      normalizedAtoms = await this.normalizeWithGemini(candidates);
      logger.info(
        {
          inputId,
          total: normalizedAtoms.length,
          rejected: normalizedAtoms.filter((a) => a.reject).length,
        },
        "A1: Gemini normalization complete",
      );
    } catch (error) {
      if (error instanceof MockGeminiError) {
        logger.info({ inputId }, "A1: using deterministic fallback (mock mode)");
      } else {
        logger.warn({ inputId, error }, "A1: Gemini failed, using deterministic fallback");
      }
      normalizedAtoms = candidates.map((c) => ({
        title: c.text.slice(0, 80),
        claim: c.text,
        kind: "fact" as AtomKind,
        confidence: 0.6,
        reject: false,
      }));
    }

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
    // The handler will use these atomIds for the emitted event
    // We mutate the original array to communicate back
    _previousAtomIds.length = 0;
    for (const { atomId } of atomEntries) {
      _previousAtomIds.push(atomId);
    }

    await this.inputProgressRepository.advance({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "resolving_topic",
      currentPhase: "A1_ATOMIZER",
      lastEventType: "atom.created",
      traceId: envelope.traceId,
    });
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

    await this.inputProgressRepository.advance({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      inputId,
      status: "updating_draft",
      currentPhase: "TOPIC_RESOLVER",
      lastEventType: envelope.type,
      traceId: envelope.traceId,
      resolvedTopicId,
      resolutionMode,
    });
  }

  // ── Gemini normalization ────────────────────────────────────────────────

  private async normalizeWithGemini(candidates: ClaimCandidate[]): Promise<NormalizedAtom[]> {
    if (candidates.length === 0) return [];

    const prompt = buildNormalizationPrompt(candidates);

    const { parsed } = await callGemini<NormalizedAtom[]>(prompt, (value) => {
      if (!Array.isArray(value)) {
        throw new Error("Expected an array of normalized atoms");
      }
      return value.map((item: Record<string, unknown>) => ({
        title: typeof item.title === "string" ? item.title.slice(0, 120) : "Untitled",
        claim: typeof item.claim === "string" ? item.claim : "",
        kind: VALID_KINDS.includes(item.kind as AtomKind) ? (item.kind as AtomKind) : "fact",
        confidence: snapToConfidenceBucket(
          typeof item.confidence === "number" ? item.confidence : 0.6,
        ),
        reject: item.reject === true,
        rejectReason: typeof item.rejectReason === "string" ? item.rejectReason : undefined,
      }));
    });

    return parsed;
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Stage 1: Deterministic claim boundary splitting.
 * Splits text by sentence boundaries, bullet points, and discourse markers.
 */
export function splitIntoClaims(text: string): ClaimCandidate[] {
  if (!text || text.trim().length === 0) {
    return [{ index: 0, text: text?.trim() || "", sourceSpan: "" }];
  }

  const candidates: ClaimCandidate[] = [];

  // Split by newlines first, then by sentence boundaries within each line
  const lines = text.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 0);

  for (const line of lines) {
    // Strip bullet markers
    const cleaned = line.replace(/^[\s]*[-*•▪▸►◆]\s*/, "").trim();
    if (cleaned.length === 0) continue;

    // Split by sentence boundaries (Japanese and English)
    const sentences = cleaned
      .split(/(?<=[。．.!?！？;；])\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Further split by discourse markers for multi-claim sentences
    for (const sentence of sentences) {
      const subClaims = splitByDiscourseMarkers(sentence);
      for (const sub of subClaims) {
        if (sub.trim().length > 0) {
          candidates.push({
            index: candidates.length,
            text: sub.trim(),
            sourceSpan: sentence,
          });
        }
      }
    }
  }

  if (candidates.length === 0) {
    return [{ index: 0, text: text.trim(), sourceSpan: text.trim() }];
  }

  return candidates;
}

const DISCOURSE_MARKERS = /(?:しかし|一方で?|また|さらに|ただし|ところが|なお|加えて|because|therefore|however|moreover|furthermore|additionally|on the other hand|in contrast|meanwhile)/gi;

function splitByDiscourseMarkers(sentence: string): string[] {
  // Only split if the sentence is long enough to likely contain multiple claims
  if (sentence.length < 40) return [sentence];

  const parts = sentence.split(DISCOURSE_MARKERS).map((s) => s.trim()).filter((s) => s.length > 5);
  return parts.length > 1 ? parts : [sentence];
}

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

function buildNormalizationPrompt(candidates: ClaimCandidate[]): string {
  const candidateList = candidates
    .map(
      (c, i) =>
        `[${i}] "${c.text}"${c.sourceSpan !== c.text ? ` (from: "${c.sourceSpan}")` : ""}`,
    )
    .join("\n");

  return `You are a knowledge normalization agent. For each claim candidate below, return a JSON array where each element has:
- "title": a short (≤80 chars) descriptive title
- "claim": the normalized, self-contained claim text
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

Candidates:
${candidateList}

Return ONLY a JSON array, no other text.`;
}
