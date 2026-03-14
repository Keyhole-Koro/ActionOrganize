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
