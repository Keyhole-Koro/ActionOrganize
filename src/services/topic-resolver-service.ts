import { env } from "../config/env.js";
import { TemporaryDependencyError } from "../core/errors.js";
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
    const candidates = await this.topicRepository.listCandidates(envelope.workspaceId, 5);
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

    if (!env.VERTEX_USE_REAL_API || scored.length === 0) {
      const resolution = this.resolveDeterministically(
        envelope,
        scored,
        candidateTopicIds,
        candidateTopicStates,
      );
      logger.info(
        {
          traceId: envelope.traceId,
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          inputId,
          resolutionMode: resolution.resolutionMode,
          resolutionConfidence: resolution.resolutionConfidence,
          candidateTopicIds,
          resolverMode: "deterministic",
        },
        "topic resolved",
      );
      return resolution;
    }

    const gemini = await this.resolveWithGemini(queryText, scored);
    const top = scored[0];
    const second = scored[1];
    const candidatesCompete = Boolean(second && top.score - second.score < SCORE_GAP_THRESHOLD);
    const resolvedTopicInCandidates =
      typeof gemini.resolvedTopicId === "string" &&
      scored.some(({ candidate }) => candidate.topicId === gemini.resolvedTopicId);
    const canAttach =
      gemini.decision === "attach_existing" &&
      resolvedTopicInCandidates &&
      gemini.confidence >= ATTACH_THRESHOLD &&
      !candidatesCompete;

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
            geminiModel: env.GEMINI_MODEL,
            resolverMode: "gemini",
          },
          "topic resolved",
        );
        return resolution;
      }
    }

    const resolution: TopicResolution = {
      resolvedTopicId: envelope.topicId,
      resolutionMode: "new",
      resolutionConfidence: Math.max(0.35, gemini.confidence || top.score),
      resolutionReason: candidatesCompete
        ? "top candidates are too close, so creating a new topic is safer"
        : gemini.reason,
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
        geminiModel: env.GEMINI_MODEL,
        resolverMode: "gemini",
      },
      "topic resolved",
    );
    return resolution;
  }

  private resolveDeterministically(
    envelope: EventEnvelope,
    scored: ScoredCandidate[],
    candidateTopicIds: string[],
    candidateTopicStates: Record<string, string>,
  ): TopicResolution {
    const top = scored[0];
    const second = scored[1];
    const hasClearWinner =
      top &&
      top.score >= ATTACH_THRESHOLD &&
      (!second || top.score - second.score >= SCORE_GAP_THRESHOLD);

    if (hasClearWinner) {
      return {
        resolvedTopicId: top.candidate.topicId,
        resolutionMode: "existing",
        resolutionConfidence: top.score,
        resolutionReason: "center target and primary nodes align with existing topic",
        topicLifecycleStateAtResolution: top.candidate.status,
        candidateTopicIds,
        candidateTopicStates,
      };
    }

    return {
      resolvedTopicId: envelope.topicId,
      resolutionMode: "new",
      resolutionConfidence: top ? Math.max(0.35, top.score) : 0.35,
      resolutionReason: "candidates overlap weakly or compete, so a new topic is safer",
      topicLifecycleStateAtResolution: "active",
      candidateTopicIds,
      candidateTopicStates,
    };
  }

  private async resolveWithGemini(queryText: string, scored: ScoredCandidate[]): Promise<GeminiResolution> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GOOGLE_API_KEY}`,

      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: this.buildGeminiPrompt(queryText, scored.slice(0, 5)),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      },
    )
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") {
          throw new TemporaryDependencyError("topic resolver Gemini request timed out");
        }
        throw new TemporaryDependencyError(
          `topic resolver Gemini request failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      })
      .finally(() => {
        clearTimeout(timeout);
      });

    if (!response.ok) {
      throw new TemporaryDependencyError(`topic resolver Gemini request failed with ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new TemporaryDependencyError("topic resolver Gemini response was empty");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.extractJson(text));
    } catch {
      throw new TemporaryDependencyError("topic resolver Gemini response was not valid JSON");
    }

    return this.validateGeminiResolution(parsed);
  }

  private buildGeminiPrompt(queryText: string, scored: ScoredCandidate[]): string {
    const candidates = scored.map(({ candidate, score }) => ({
      topicId: candidate.topicId,
      title: candidate.title,
      status: candidate.status,
      deterministicScore: Number(score.toFixed(4)),
    }));

    return [
      "You are a topic resolver for a long-lived knowledge graph.",
      "Choose whether to attach to an existing topic or create a new topic.",
      "Return JSON only with keys: decision, resolvedTopicId, confidence, reason.",
      "decision must be attach_existing or create_new.",
      "confidence must be a number between 0 and 1.",
      "When decision is attach_existing, resolvedTopicId MUST be one of the provided candidate topicIds.",
      "If create_new, resolvedTopicId can be omitted.",
      "",
      `queryText: ${queryText}`,
      `candidates: ${JSON.stringify(candidates)}`,
    ].join("\n");
  }

  private extractJson(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      return trimmed.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
    }
    return trimmed;
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
