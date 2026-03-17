import { env } from "../config/env.js";
import { TemporaryDependencyError } from "../core/errors.js";
import { callGemini } from "../lib/gemini-client.js";
import { logger } from "../lib/logger.js";
import { AtomRepository } from "../repositories/atom-repository.js";
import { TopicRepository, type TopicCandidate } from "../repositories/topic-repository.js";
import type { EventEnvelope } from "../models/envelope.js";

export type TopicResolution = {
  resolvedTopicId: string;
  resolutionMode: "existing" | "new";
  resolutionConfidence: number;
  resolutionReason: string;
  topicLifecycleStateAtResolution: string;
  candidateTopicIds: string[];
  candidateTopicStates: Record<string, string>;
};

const ATTACH_THRESHOLD = 0.8;
const SCORE_GAP_THRESHOLD = 0.15;
const GEMINI_TIMEOUT_MS = 7000;

type ScoredCandidate = {
  candidate: TopicCandidate;
  score: number;
};

type GeminiResolution = {
  decision: "attach_existing" | "create_new";
  resolvedTopicId?: string;
  confidence: number;
  reason: string;
};

export class TopicResolverService {
  private readonly topicRepository = new TopicRepository();
  private readonly atomRepository = new AtomRepository();

  async resolve(envelope: EventEnvelope, inputId: string, atomIds: string[]): Promise<TopicResolution> {
    const candidates = await this.topicRepository.listCandidates(envelope.workspaceId, 10);
    const atoms = await this.atomRepository.getByIds(envelope.workspaceId, envelope.topicId, atomIds);
    const queryText = [
      typeof envelope.payload.text === "string" ? envelope.payload.text : "",
      ...atoms.map((atom) => `${atom.title} ${atom.claim}`),
    ]
      .join(" ")
      .trim();

    const scored = candidates
      .map((candidate) => ({
        candidate,
        score: this.scoreCandidate(candidate, queryText, envelope.topicId),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const candidateTopicIds = scored.map(({ candidate }) => candidate.topicId);
    const candidateTopicStates = Object.fromEntries(
      scored.map(({ candidate }) => [candidate.topicId, candidate.status]),
    );

    // Consultation with Gemini is mandatory. No deterministic short-circuits or fallbacks.
    const gemini = await this.resolveWithGemini(queryText, scored);

    const resolvedTopicInCandidates =
      typeof gemini.resolvedTopicId === "string" &&
      scored.some(({ candidate }) => candidate.topicId === gemini.resolvedTopicId);

    const canAttach =
      gemini.decision === "attach_existing" &&
      resolvedTopicInCandidates &&
      gemini.confidence >= 0.1; // Lower threshold for AI-driven attachment, relying on Gemini's judgment

    if (canAttach) {
      const selected = scored.find(({ candidate }) => candidate.topicId === gemini.resolvedTopicId);
      if (selected) {
        const resolution: TopicResolution = {
          resolvedTopicId: selected.candidate.topicId,
          resolutionMode: "existing",
          resolutionConfidence: gemini.confidence,
          resolutionReason: gemini.reason,
          topicLifecycleStateAtResolution: selected.candidate.status,
          candidateTopicIds,
          candidateTopicStates,
        };
        logger.info(
          {
            traceId: envelope.traceId,
            workspaceId: envelope.workspaceId,
            topicId: envelope.topicId,
            inputId,
            resolutionMode: resolution.resolutionMode,
            resolutionConfidence: resolution.resolutionConfidence,
            candidateTopicIds,
            resolvedTopicId: resolution.resolvedTopicId,
            geminiModel: env.GEMINI_MODEL_QUALITY,
            resolverMode: "gemini",
          },
          "topic resolved",
        );
        return resolution;
      }
    }

    // Default to new topic if AI decides so or if attachment is invalid
    const resolution: TopicResolution = {
      resolvedTopicId: envelope.topicId,
      resolutionMode: "new",
      resolutionConfidence: gemini.confidence,
      resolutionReason: gemini.reason,
      topicLifecycleStateAtResolution: "active",
      candidateTopicIds,
      candidateTopicStates,
    };
    logger.info(
      {
        traceId: envelope.traceId,
        workspaceId: envelope.workspaceId,
        topicId: envelope.topicId,
        inputId,
        resolutionMode: resolution.resolutionMode,
        resolutionConfidence: resolution.resolutionConfidence,
        candidateTopicIds,
        resolvedTopicId: resolution.resolvedTopicId,
        geminiModel: env.GEMINI_MODEL_QUALITY,
        resolverMode: "gemini",
      },
      "topic resolved",
    );
    return resolution;
  }

  private async resolveWithGemini(queryText: string, scored: ScoredCandidate[]): Promise<GeminiResolution> {
    const { parsed } = await callGemini(
      this.buildGeminiPrompt(queryText, scored.slice(0, 5)),
      (value) => this.validateGeminiResolution(value),
      { timeoutMs: GEMINI_TIMEOUT_MS, modelTier: "quality" },
    );
    return parsed;
  }

  private buildGeminiPrompt(queryText: string, scored: ScoredCandidate[]): string {
    const candidates = scored.map(({ candidate, score }) => ({
      topicId: candidate.topicId,
      title: candidate.title,
      status: candidate.status,
      heuristicOverlapScore: Number(score.toFixed(4)),
    }));

    const candidatesSection = candidates.length > 0
      ? `Candidates:\n${JSON.stringify(candidates, null, 2)}`
      : "No existing candidates found in the current workspace.";

    return [
      "You are a topic resolver for a long-lived knowledge graph.",
      "Analyze the query text and decide whether it should be attached to an existing topic or if it warrants a new topic.",
      "Return JSON only with keys: decision, resolvedTopicId, confidence, reason.",
      "decision must be 'attach_existing' or 'create_new'.",
      "confidence must be a number between 0 and 1.",
      "If decision is 'attach_existing', resolvedTopicId MUST be one of the provided candidate topicIds.",
      "If decision is 'create_new' or if there are no candidates, set decision to 'create_new' and omit resolvedTopicId (or set it to null).",
      "",
      `Query Text: ${queryText}`,
      "",
      candidatesSection,
    ].join("\n");
  }

  private validateGeminiResolution(value: unknown): GeminiResolution {
    if (typeof value !== "object" || value === null) {
      throw new TemporaryDependencyError("topic resolver Gemini response shape was invalid");
    }

    const decision = (value as Record<string, unknown>).decision;
    const resolvedTopicId = (value as Record<string, unknown>).resolvedTopicId;
    const confidence = (value as Record<string, unknown>).confidence;
    const reason = (value as Record<string, unknown>).reason;

    if (decision !== "attach_existing" && decision !== "create_new") {
      throw new TemporaryDependencyError("topic resolver Gemini decision was invalid");
    }
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new TemporaryDependencyError("topic resolver Gemini confidence was invalid");
    }
    if (typeof reason !== "string" || reason.length === 0) {
      throw new TemporaryDependencyError("topic resolver Gemini reason was invalid");
    }
    if (resolvedTopicId !== undefined && (typeof resolvedTopicId !== "string" || resolvedTopicId.length === 0)) {
      throw new TemporaryDependencyError("topic resolver Gemini resolvedTopicId was invalid");
    }

    return {
      decision,
      resolvedTopicId: resolvedTopicId as string | undefined,
      confidence,
      reason,
    };
  }

  private scoreCandidate(candidate: TopicCandidate, queryText: string, hintedTopicId: string): number {
    const queryTokens = this.tokenize(queryText);
    const candidateTokens = [...this.tokenize(candidate.title)];
    const shared = candidateTokens.filter((token) => queryTokens.has(token));
    const overlapScore =
      candidateTokens.length === 0 ? 0 : shared.length / new Set(candidateTokens).size;
    const hintedScore = candidate.topicId === hintedTopicId ? 0.35 : 0;
    return Math.min(1, overlapScore + hintedScore);
  }

  private tokenize(input: string): Set<string> {
    return new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    );
  }
}
