import { FieldValue } from "@google-cloud/firestore";
import { env } from "../config/env.js";
import { TemporaryDependencyError } from "../core/errors.js";
import type { EventEnvelope } from "../models/envelope.js";
import { IndexItemRepository } from "../repositories/index-item-repository.js";
import { InputProgressRepository } from "../repositories/input-progress-repository.js";
import { NodeRepository } from "../repositories/node-repository.js";
import { OutlineRepository } from "../repositories/outline-repository.js";
import { PipelineBundleRepository } from "../repositories/pipeline-bundle-repository.js";
import type { PipelineBundleSnapshot } from "../repositories/pipeline-bundle-repository.js";
import { TopicRepository } from "../repositories/topic-repository.js";
import { BundleDescriptionRepository } from "../repositories/bundle-description-repository.js";
import { EdgeRepository } from "../repositories/edge-repository.js";
import { AtomRepository } from "../repositories/atom-repository.js";
import { dedupeNodeIds, resolveNode } from "./cleaner-entity-resolution.js";
import { callGemini, MockGeminiError } from "../lib/gemini-client.js";
import { writeHtml } from "../lib/gcs-writer.js";
import { logger } from "../lib/logger.js";

type DraftBundleResult = {
  bundleId: string;
  schemaVersion: number;
};

type OutlineApplyResult = {
  outlineVersion: number;
  changedNodeIds: string[];
  descRef: string;
  reissuedAtomIds: string[];
};

type HierarchyCandidate = {
  nodeId: string;
  title: string;
  clusterNodeId: string;
  clusterTitle: string;
  subclusterNodeId: string;
  subclusterTitle: string;
};

type SubclusterGroup = {
  subclusterNodeId: string;
  subclusterTitle: string;
  claims: Array<{ nodeId: string; title: string }>;
};

type ClusterGroup = {
  clusterNodeId: string;
  clusterTitle: string;
  claims: Array<{ nodeId: string; title: string }>;
  subclusters: SubclusterGroup[];
};

type HierarchyPlan = {
  rootClaims: Array<{ nodeId: string; title: string }>;
  clusters: ClusterGroup[];
};

type SchemaAttributeDef = {
  type: string;
  required: boolean;
};

type SchemaIndexFeatureDef = {
  type: string;
  source: string;
};

export class PipelineWriteService {
  private readonly topicRepository = new TopicRepository();
  private readonly bundleRepository = new PipelineBundleRepository();
  private readonly outlineRepository = new OutlineRepository();
  private readonly nodeRepository = new NodeRepository();
  private readonly indexItemRepository = new IndexItemRepository();
  private readonly inputProgressRepository = new InputProgressRepository();
  private readonly bundleDescriptionRepository = new BundleDescriptionRepository();
  private readonly edgeRepository = new EdgeRepository();
  private readonly atomRepository = new AtomRepository();

  private isFirestoreBackend() {
    return env.STATE_BACKEND === "firestore";
  }

  async onDraftUpdated(
    envelope: EventEnvelope,
    draftVersion: number,
    appendedAtomIds: string[],
    inputId?: string,
  ): Promise<DraftBundleResult> {
    const bundleId = `bundle:${envelope.topicId}:v${draftVersion}`;
    if (!this.isFirestoreBackend()) {
      return { bundleId, schemaVersion: 1 };
    }

    const topicRef = this.topicRepository.docRef(envelope.workspaceId, envelope.topicId);
    const topicSnapshot = await topicRef.get();
    const schemaVersion =
      typeof topicSnapshot.get("schemaVersion") === "number" ? topicSnapshot.get("schemaVersion") : 1;

    await this.bundleRepository.upsert({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      bundleId,
      sourceDraftVersion: draftVersion,
      schemaVersion,
      atomCount: appendedAtomIds.length,
      sourceAtomIds: appendedAtomIds,
      sourceInputId: inputId,
    });

    return { bundleId, schemaVersion };
  }

  async onBundleCreated(
    envelope: EventEnvelope,
    bundleId: string,
    sourceDraftVersion: number,
    inputId?: string,
  ): Promise<OutlineApplyResult> {
    const rootNodeId = `node:${envelope.topicId}:root`;
    const descRef = this.toBundleDescRef(bundleId, sourceDraftVersion);
    const outlineRef = this.toOutlineRef(envelope.topicId, sourceDraftVersion);

    if (!this.isFirestoreBackend()) {
      return {
        outlineVersion: sourceDraftVersion,
        changedNodeIds: [rootNodeId],
        descRef,
        reissuedAtomIds: [],
      };
    }

    const bundle = await this.bundleRepository.get(envelope.workspaceId, envelope.topicId, bundleId);
    if (bundle?.appliedAt) {
      return {
        outlineVersion: sourceDraftVersion,
        changedNodeIds: [],
        descRef,
        reissuedAtomIds: [],
      };
    }
    const applyStarted = await this.bundleRepository.tryStartApply(
      envelope.workspaceId,
      envelope.topicId,
      bundleId,
      envelope.traceId,
      env.LEASE_TTL_SECONDS * 1000,
    );
    if (!applyStarted) {
      return {
        outlineVersion: sourceDraftVersion,
        changedNodeIds: [],
        descRef,
        reissuedAtomIds: [],
      };
    }
    const bundleForApply =
      bundle?.bundleStatus === "error"
        ? {
          ...bundle,
          bundleStatus: "applying" as const,
          applyError: undefined,
        }
        : bundle;
    const outlineSummary = this.toOutlineSummary(envelope.topicId, bundleId, sourceDraftVersion);
    const descHtml = this.toBundleDescHtml(envelope.topicId, bundleId, sourceDraftVersion, bundleForApply);
    const sourceAtomIds = bundleForApply?.sourceAtomIds ?? [];
    const atoms = sourceAtomIds.length
      ? await this.atomRepository.getByIds(envelope.workspaceId, envelope.topicId, sourceAtomIds)
      : [];
    const reissuedAtomIds = atoms
      .filter((atom) => atom.confidence < 0.5 || atom.claim.trim().length === 0)
      .map((atom) => atom.atomId);
    const candidateAtoms = atoms.filter((atom) => !reissuedAtomIds.includes(atom.atomId));
    const existingClaimNodes = await this.nodeRepository.listClaimNodes(
      envelope.workspaceId,
      envelope.topicId,
    );
    const resolvedCandidates = candidateAtoms.map((atom) => {
      const fallbackNodeId = this.toAtomNodeId(envelope.topicId, atom.atomId);
      const resolved = resolveNode(existingClaimNodes, {
        atomTitle: atom.title,
        atomClaim: atom.claim,
        fallbackNodeId,
        schemaVersion: bundleForApply?.schemaVersion,
      });
      return {
        atom,
        nodeId: resolved.nodeId,
        isMerged: resolved.isMerged,
        similarity: resolved.similarity,
      };
    });
    const hierarchyCandidates = resolvedCandidates.map((item) => {
      const clusterTitle = this.deriveClusterTitle(item.atom.title, item.atom.claim);
      const subclusterTitle = this.deriveSubclusterTitle(clusterTitle, item.atom.title, item.atom.claim);
      const clusterSlug = this.toStableSlug(clusterTitle);
      const subclusterSlug = this.toStableSlug(subclusterTitle);

      return {
        nodeId: item.nodeId,
        title: item.atom.title,
        clusterNodeId: this.toClusterNodeId(envelope.topicId, clusterSlug),
        clusterTitle,
        subclusterNodeId: this.toSubclusterNodeId(envelope.topicId, clusterSlug, subclusterSlug),
        subclusterTitle,
      } satisfies HierarchyCandidate;
    });
    const hierarchyPlan = this.buildHierarchyPlan(hierarchyCandidates);
    const claimPlacementByNodeId = this.buildClaimPlacement(rootNodeId, hierarchyPlan);
    const schemaNodeKinds = dedupeNodeIds([
      "topic",
      "claim",
      ...(hierarchyPlan.clusters.length > 0 ? ["cluster"] : []),
      ...(hierarchyPlan.clusters.some((cluster) => cluster.subclusters.length > 0)
        ? ["subcluster"]
        : []),
    ]);
    const outlineMap = this.toOutlineMap(envelope.topicId, rootNodeId, hierarchyPlan);
    const changedNodeIds = dedupeNodeIds([
      rootNodeId,
      ...hierarchyPlan.clusters.map((cluster) => cluster.clusterNodeId),
      ...hierarchyPlan.clusters.flatMap((cluster) =>
        cluster.subclusters.map((subcluster) => subcluster.subclusterNodeId),
      ),
      ...resolvedCandidates.map((item) => item.nodeId),
    ]);

    try {
      await this.bundleDescriptionRepository.writeHtml(descRef, descHtml);
      await this.bundleDescriptionRepository.writeMarkdown(outlineRef, `${outlineSummary}\n\n${outlineMap}`);
    } catch (error) {
      await this.bundleRepository.markApplyFailed(
        envelope.workspaceId,
        envelope.topicId,
        bundleId,
        "artifact_write_failed",
        error instanceof Error ? error.message : "unknown error",
      );
      throw new TemporaryDependencyError(
        `failed to write bundle/outline artifacts: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    const firestore = this.topicRepository.firestoreClient;
    const topicRef = this.topicRepository.docRef(envelope.workspaceId, envelope.topicId);
    const outlineVersion = await firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(topicRef);
      const schemaVersion =
        typeof snapshot.get("schemaVersion") === "number" ? snapshot.get("schemaVersion") : 1;
      const nextOutlineVersion = sourceDraftVersion;

      this.outlineRepository.write(tx, {
        workspaceId: envelope.workspaceId,
        topicId: envelope.topicId,
        version: nextOutlineVersion,
        summaryMd: outlineSummary,
        mapMd: outlineMap,
      });

      tx.set(
        topicRef,
        {
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          latestOutlineVersion: nextOutlineVersion,
          latestOutlineRef: outlineRef,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      const schemaRef = this.topicRepository.schemaDocRef(
        envelope.workspaceId,
        envelope.topicId,
        schemaVersion,
      );
      tx.set(
        schemaRef,
        {
          topicId: envelope.topicId,
          version: schemaVersion,
          status: "active",
          node_kinds: FieldValue.arrayUnion(...schemaNodeKinds),
          relation_types: FieldValue.arrayUnion("contains"),
          attribute_defs: this.defaultSchemaAttributeDefs(),
          index_feature_defs: this.defaultSchemaIndexFeatureDefs(),
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      this.nodeRepository.write(tx, {
        workspaceId: envelope.workspaceId,
        topicId: envelope.topicId,
        nodeId: rootNodeId,
        kind: "topic",
        title: `Topic ${envelope.topicId}`,
        parentId: null,
        schemaVersion,
        contextSummary: `Outline v${nextOutlineVersion} generated from ${bundleId}`,
      });

      for (const cluster of hierarchyPlan.clusters) {
        this.nodeRepository.write(tx, {
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          nodeId: cluster.clusterNodeId,
          kind: "cluster",
          title: cluster.clusterTitle,
          parentId: rootNodeId,
          schemaVersion,
          contextSummary: `Cluster for outline v${nextOutlineVersion}`,
        });
        this.edgeRepository.write(tx, {
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          edgeId: this.toEdgeId(rootNodeId, cluster.clusterNodeId),
          sourceNodeId: rootNodeId,
          targetNodeId: cluster.clusterNodeId,
          relationType: "contains",
          schemaVersion,
        });

        for (const subcluster of cluster.subclusters) {
          this.nodeRepository.write(tx, {
            workspaceId: envelope.workspaceId,
            topicId: envelope.topicId,
            nodeId: subcluster.subclusterNodeId,
            kind: "subcluster",
            title: subcluster.subclusterTitle,
            parentId: cluster.clusterNodeId,
            schemaVersion,
            contextSummary: `Subcluster for outline v${nextOutlineVersion}`,
          });
          this.edgeRepository.write(tx, {
            workspaceId: envelope.workspaceId,
            topicId: envelope.topicId,
            edgeId: this.toEdgeId(cluster.clusterNodeId, subcluster.subclusterNodeId),
            sourceNodeId: cluster.clusterNodeId,
            targetNodeId: subcluster.subclusterNodeId,
            relationType: "contains",
            schemaVersion,
          });
        }
      }

      for (const candidate of resolvedCandidates) {
        const parentId = claimPlacementByNodeId.get(candidate.nodeId) ?? rootNodeId;
        const atomNodeId = candidate.nodeId;
        this.nodeRepository.write(tx, {
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          nodeId: atomNodeId,
          kind: "claim",
          title: candidate.atom.title,
          parentId,
          schemaVersion,
          contextSummary: candidate.isMerged
            ? `Merged from bundle ${bundleId} (score=${candidate.similarity.toFixed(2)}): ${candidate.atom.claim}`
            : candidate.atom.claim,
        });
        this.edgeRepository.write(tx, {
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          edgeId: this.toEdgeId(parentId, atomNodeId),
          sourceNodeId: parentId,
          targetNodeId: atomNodeId,
          relationType: "contains",
          schemaVersion,
        });
      }

      return nextOutlineVersion;
    });

    await this.bundleRepository.markApplied(envelope.workspaceId, envelope.topicId, bundleId);

    if (inputId) {
      await this.inputProgressRepository.advance({
        workspaceId: envelope.workspaceId,
        topicId: envelope.topicId,
        inputId,
        status: "completed",
        currentPhase: "A3_CLEANER",
        lastEventType: "outline.updated",
        traceId: envelope.traceId,
        completedAt: true,
      });
    }

    return { outlineVersion, changedNodeIds, descRef, reissuedAtomIds };
  }

  async onBundleDescribed(envelope: EventEnvelope, bundleId: string, descRef: string) {
    if (!this.isFirestoreBackend()) {
      return;
    }

    await this.bundleRepository.markDescribed(
      envelope.workspaceId,
      envelope.topicId,
      bundleId,
      descRef,
    );
  }

  async onOutlineUpdated(
    envelope: EventEnvelope,
    outlineVersion: number,
    changedNodeIds: string[],
  ) {
    if (!this.isFirestoreBackend()) {
      return;
    }

    const topicRef = this.topicRepository.docRef(envelope.workspaceId, envelope.topicId);
    const topicSnapshot = await topicRef.get();
    const schemaVersion =
      typeof topicSnapshot.get("schemaVersion") === "number" ? topicSnapshot.get("schemaVersion") : 1;

    await Promise.all(
      changedNodeIds.map((nodeId, index) =>
        this.indexItemRepository.upsert({
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          indexItemId: `index:${nodeId}:v${outlineVersion}`,
          nodeId,
          schemaVersion,
          outlineVersion,
          relationImportance: 1 - index * 0.1,
          recency: outlineVersion,
          confidence: 0.8,
          evidenceCount: 1,
          edgeCount: 0,
          depth: index,
        }),
      ),
    );

    const mapRef = this.toMapRef(envelope.topicId, outlineVersion);
    const mapMarkdown = this.toMapMarkdown(envelope.topicId, outlineVersion, changedNodeIds);
    try {
      await this.bundleDescriptionRepository.writeMarkdown(mapRef, mapMarkdown);
    } catch (error) {
      throw new TemporaryDependencyError(
        `failed to write map artifact: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    await topicRef.set(
      {
        latestMapVersion: outlineVersion,
        latestMapRef: mapRef,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async onNodeRollupRequested(
    envelope: EventEnvelope,
    nodeId: string,
    generation: number,
  ): Promise<{ topicId: string; nodeId: string; skipped: boolean }> {
    if (!this.isFirestoreBackend()) {
      return { topicId: envelope.topicId, nodeId, skipped: false };
    }

    const existing = await this.nodeRepository.docRef(envelope.workspaceId, envelope.topicId, nodeId).get();
    const watermark = existing.get("rollupWatermark");
    if (typeof watermark === "number" && watermark >= generation) {
      return { topicId: envelope.topicId, nodeId, skipped: true };
    }

    // Gather child nodes for context
    const childNodes = await this.nodeRepository.listByParent(
      envelope.workspaceId,
      envelope.topicId,
      nodeId,
    );
    const currentTitle = existing.get("title") ?? nodeId;
    const currentKind = existing.get("kind") ?? "topic";

    // Try LLM rollup
    let rollupHtml: string;
    let contextSummary: string;
    try {
      const childSummaries = childNodes
        .map((c) => `- ${c.title}: ${c.contextSummary ?? "(no summary)"}`.slice(0, 200))
        .join("\n");

      const prompt = `You are a knowledge summarizer. Generate a concise HTML summary for the following knowledge graph node and its children.

Node: "${currentTitle}" (kind: ${currentKind})

Child nodes:
${childSummaries || "(no child nodes)"}

Return a JSON object:
{
  "html": "<section>...</section> — a brief HTML summary with h1, p, and ul elements",
  "contextSummary": "a 1-2 sentence plain text summary suitable for embedding in prompts"
}
Return ONLY the JSON object, no other text.`;

      const { parsed } = await callGemini<{ html: string; contextSummary: string }>(
        prompt,
        (value) => {
          const obj = value as Record<string, unknown>;
          return {
            html: typeof obj.html === "string" ? obj.html : `<section><h1>${currentTitle}</h1></section>`,
            contextSummary:
              typeof obj.contextSummary === "string"
                ? obj.contextSummary
                : `Summary for ${currentTitle}`,
          };
        },
      );
      rollupHtml = parsed.html;
      contextSummary = parsed.contextSummary;
    } catch (error) {
      if (error instanceof MockGeminiError) {
        logger.info({ nodeId }, "A7: mock mode, using template rollup");
      } else {
        logger.warn({ nodeId, error }, "A7: Gemini failed, using template rollup");
      }
      rollupHtml = `<section><h1>${this.escapeHtml(String(currentTitle))}</h1><p>Rollup generation ${generation}</p></section>`;
      contextSummary = `Rollup generated for ${nodeId} at generation ${generation}`;
    }

    // Write rollup HTML to GCS
    const rollupRef = `mind/node_rollup/${nodeId}/v${generation}.html`;
    try {
      await writeHtml(rollupRef, rollupHtml);
    } catch (error) {
      logger.warn({ error, nodeId }, "failed to write rollup to GCS, continuing");
    }

    await this.nodeRepository.upsert({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      nodeId,
      kind: String(currentKind),
      title: String(currentTitle),
      rollupRef,
      rollupWatermark: generation,
      contextSummary,
      detailHtml: rollupHtml,
    });

    return { topicId: envelope.topicId, nodeId, skipped: false };
  }

  async onTopicSchemaUpdated(envelope: EventEnvelope, schemaVersion: number) {
    if (!this.isFirestoreBackend()) {
      return;
    }

    const topicRef = this.topicRepository.docRef(envelope.workspaceId, envelope.topicId);
    await this.topicRepository.firestoreClient.runTransaction(async (tx) => {
      const snapshot = await tx.get(topicRef);
      const current = snapshot.get("schemaVersion");
      const currentVersion = typeof current === "number" ? current : 1;
      if (schemaVersion <= currentVersion) {
        return;
      }

      const schemaRef = this.topicRepository.schemaDocRef(
        envelope.workspaceId,
        envelope.topicId,
        schemaVersion,
      );

      tx.set(
        topicRef,
        {
          schemaVersion,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      tx.set(
        schemaRef,
        {
          topicId: envelope.topicId,
          version: schemaVersion,
          status: "active",
          node_kinds: FieldValue.arrayUnion("topic", "claim"),
          relation_types: FieldValue.arrayUnion("contains"),
          attribute_defs: this.defaultSchemaAttributeDefs(),
          index_feature_defs: this.defaultSchemaIndexFeatureDefs(),
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }

  private toOutlineSummary(topicId: string, bundleId: string, sourceDraftVersion: number) {
    return [
      `# Outline ${topicId}`,
      "",
      `Source bundle: ${bundleId}`,
      `Source draft version: ${sourceDraftVersion}`,
    ].join("\n");
  }

  private toOutlineMap(topicId: string, rootNodeId: string, hierarchyPlan: HierarchyPlan) {
    const lines = [`# Map ${topicId}`, "", `- ${rootNodeId}`];

    for (const claim of hierarchyPlan.rootClaims) {
      lines.push(`  - ${claim.title} (${claim.nodeId})`);
    }

    for (const cluster of hierarchyPlan.clusters) {
      lines.push(`  - ${cluster.clusterTitle} (${cluster.clusterNodeId})`);
      for (const claim of cluster.claims) {
        lines.push(`    - ${claim.title} (${claim.nodeId})`);
      }
      for (const subcluster of cluster.subclusters) {
        lines.push(`    - ${subcluster.subclusterTitle} (${subcluster.subclusterNodeId})`);
        for (const claim of subcluster.claims) {
          lines.push(`      - ${claim.title} (${claim.nodeId})`);
        }
      }
    }

    return lines.join("\n");
  }

  private toMapMarkdown(topicId: string, outlineVersion: number, changedNodeIds: string[]) {
    return [
      `# Map ${topicId}`,
      "",
      `Outline version: ${outlineVersion}`,
      "",
      ...changedNodeIds.map((nodeId) => `- ${nodeId}`),
    ].join("\n");
  }

  private toBundleDescRef(bundleId: string, version: number) {
    return `mind/bundle_desc/${bundleId}/v${version}.html`;
  }

  private toOutlineRef(topicId: string, version: number) {
    return `mind/outlines/${topicId}/v${version}.md`;
  }

  private toMapRef(topicId: string, version: number) {
    return `mind/maps/${topicId}/v${version}.md`;
  }

  private toAtomNodeId(topicId: string, atomId: string) {
    return `node:${topicId}:atom:${atomId}`;
  }

  private toClusterNodeId(topicId: string, clusterSlug: string) {
    return `node:${topicId}:cluster:${clusterSlug}`;
  }

  private toSubclusterNodeId(topicId: string, clusterSlug: string, subclusterSlug: string) {
    return `node:${topicId}:subcluster:${clusterSlug}:${subclusterSlug}`;
  }

  private toEdgeId(sourceNodeId: string, targetNodeId: string) {
    return `edge:${sourceNodeId}->${targetNodeId}`;
  }

  private async deriveClusterTitleLLM(atoms: Array<{ title: string; claim: string }>): Promise<string[]> {
    if (atoms.length === 0) return [];

    const atomList = atoms
      .slice(0, 20)
      .map((a, i) => `[${i}] "${a.title}": ${a.claim.slice(0, 100)}`)
      .join("\n");

    const prompt = `You are a knowledge organization agent. Group the following claims into 3-7 thematic clusters and return a JSON array of cluster title strings.

Claims:
${atomList}

Return ONLY a JSON array of cluster title strings (3-7 items), e.g. ["Security & Access", "Performance", "Data Model"].
Use concise, professional titles.`;

    const { parsed } = await callGemini<string[]>(prompt, (value) => {
      if (!Array.isArray(value)) throw new Error("Expected array");
      return value.filter((v): v is string => typeof v === "string").slice(0, 7);
    });

    return parsed;
  }

  private deriveClusterTitle(title: string, claim: string) {
    const text = `${title} ${claim}`.toLowerCase();
    if (/auth|token|permission|access|security|credential/.test(text)) {
      return "Security & Access";
    }
    if (/latency|throughput|performance|slow|optimi[sz]e/.test(text)) {
      return "Performance";
    }
    if (/schema|data|database|model|field|table/.test(text)) {
      return "Data Model";
    }
    if (/ui|ux|user|screen|onboard|journey|experience/.test(text)) {
      return "User Experience";
    }
    if (/error|retry|timeout|failure|resilien|incident/.test(text)) {
      return "Reliability";
    }
    return "General Insights";
  }

  private deriveSubclusterTitle(clusterTitle: string, title: string, claim: string) {
    const text = `${title} ${claim}`.toLowerCase();
    if (clusterTitle === "Security & Access") {
      if (/refresh|expire|ttl|lifecycle|rotation/.test(text)) {
        return "Token Lifecycle";
      }
      if (/permission|role|scope|grant/.test(text)) {
        return "Authorization Rules";
      }
      return "Security Controls";
    }
    if (clusterTitle === "Data Model") {
      if (/migration|version|evolv|compat/.test(text)) {
        return "Schema Evolution";
      }
      if (/quality|duplicate|null|missing|consisten/.test(text)) {
        return "Data Quality";
      }
      return "Data Structure";
    }
    if (clusterTitle === "Reliability") {
      if (/retry|backoff|idempot/.test(text)) {
        return "Retry Strategy";
      }
      if (/timeout|circuit|degrad|fallback/.test(text)) {
        return "Failure Handling";
      }
      return "Operational Stability";
    }
    if (clusterTitle === "Performance") {
      if (/cache|memo|index/.test(text)) {
        return "Caching & Indexing";
      }
      if (/query|join|scan/.test(text)) {
        return "Query Efficiency";
      }
      return "Runtime Efficiency";
    }
    if (clusterTitle === "User Experience") {
      if (/copy|label|text|message/.test(text)) {
        return "UI Communication";
      }
      if (/flow|step|journey|onboard/.test(text)) {
        return "Interaction Flow";
      }
      return "Product Experience";
    }
    return "Captured Claims";
  }

  private toStableSlug(value: string) {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return slug.length > 0 ? slug : "node";
  }

  private buildHierarchyPlan(candidates: HierarchyCandidate[]): HierarchyPlan {
    const MIN_CLAIMS_FOR_CLUSTER = 3;
    const MIN_CLAIMS_FOR_SUBCLUSTER = 2;
    const clusterMap = new Map<
      string,
      {
        clusterNodeId: string;
        clusterTitle: string;
        subclusterMap: Map<
          string,
          {
            subclusterNodeId: string;
            subclusterTitle: string;
            claims: Array<{ nodeId: string; title: string }>;
          }
        >;
      }
    >();

    for (const candidate of candidates) {
      if (!clusterMap.has(candidate.clusterNodeId)) {
        clusterMap.set(candidate.clusterNodeId, {
          clusterNodeId: candidate.clusterNodeId,
          clusterTitle: candidate.clusterTitle,
          subclusterMap: new Map(),
        });
      }

      const cluster = clusterMap.get(candidate.clusterNodeId)!;
      if (!cluster.subclusterMap.has(candidate.subclusterNodeId)) {
        cluster.subclusterMap.set(candidate.subclusterNodeId, {
          subclusterNodeId: candidate.subclusterNodeId,
          subclusterTitle: candidate.subclusterTitle,
          claims: [],
        });
      }

      cluster.subclusterMap.get(candidate.subclusterNodeId)!.claims.push({
        nodeId: candidate.nodeId,
        title: candidate.title,
      });
    }

    const rootClaims: Array<{ nodeId: string; title: string }> = [];

    const clusters = [...clusterMap.values()]
      .map((cluster) => {
        const sortedSubclusters = [...cluster.subclusterMap.values()]
          .map((subcluster) => ({
            subclusterNodeId: subcluster.subclusterNodeId,
            subclusterTitle: subcluster.subclusterTitle,
            claims: subcluster.claims.sort((a, b) => a.title.localeCompare(b.title)),
          }))
          .sort((a, b) => a.subclusterTitle.localeCompare(b.subclusterTitle));

        const totalClaims = sortedSubclusters.reduce(
          (count, subcluster) => count + subcluster.claims.length,
          0,
        );

        if (totalClaims < MIN_CLAIMS_FOR_CLUSTER) {
          rootClaims.push(...sortedSubclusters.flatMap((subcluster) => subcluster.claims));
          return null;
        }

        const directClaims: Array<{ nodeId: string; title: string }> = [];
        const keptSubclusters: SubclusterGroup[] = [];

        for (const subcluster of sortedSubclusters) {
          if (subcluster.claims.length < MIN_CLAIMS_FOR_SUBCLUSTER) {
            directClaims.push(...subcluster.claims);
            continue;
          }
          keptSubclusters.push(subcluster);
        }

        if (keptSubclusters.length === 1 && directClaims.length === 0) {
          directClaims.push(...keptSubclusters[0].claims);
          keptSubclusters.length = 0;
        }

        return {
          clusterNodeId: cluster.clusterNodeId,
          clusterTitle: cluster.clusterTitle,
          claims: directClaims.sort((a, b) => a.title.localeCompare(b.title)),
          subclusters: keptSubclusters,
        };
      })
      .filter((cluster): cluster is ClusterGroup => cluster !== null)
      .sort((a, b) => a.clusterTitle.localeCompare(b.clusterTitle));

    rootClaims.sort((a, b) => a.title.localeCompare(b.title));

    return { rootClaims, clusters };
  }

  private buildClaimPlacement(rootNodeId: string, hierarchyPlan: HierarchyPlan) {
    const placements = new Map<string, string>();

    for (const claim of hierarchyPlan.rootClaims) {
      placements.set(claim.nodeId, rootNodeId);
    }

    for (const cluster of hierarchyPlan.clusters) {
      for (const claim of cluster.claims) {
        placements.set(claim.nodeId, cluster.clusterNodeId);
      }

      for (const subcluster of cluster.subclusters) {
        for (const claim of subcluster.claims) {
          placements.set(claim.nodeId, subcluster.subclusterNodeId);
        }
      }
    }

    return placements;
  }

  private defaultSchemaAttributeDefs(): Record<string, SchemaAttributeDef> {
    return {
      title: { type: "string", required: true },
      kind: { type: "string", required: true },
      parent_id: { type: "string|null", required: false },
      context_summary: { type: "string", required: false },
      schema_version: { type: "number", required: true },
    };
  }

  private defaultSchemaIndexFeatureDefs(): Record<string, SchemaIndexFeatureDef> {
    return {
      relation_importance: { type: "number", source: "indexItems.relationImportance" },
      recency: { type: "number", source: "indexItems.recency" },
      confidence: { type: "number", source: "indexItems.confidence" },
      evidence_count: { type: "number", source: "indexItems.evidenceCount" },
      edge_count: { type: "number", source: "indexItems.edgeCount" },
      depth: { type: "number", source: "indexItems.depth" },
    };
  }

  private toBundleDescHtml(
    topicId: string,
    bundleId: string,
    sourceDraftVersion: number,
    bundle?: PipelineBundleSnapshot | null,
  ) {
    const effectiveDraftVersion = bundle?.sourceDraftVersion ?? sourceDraftVersion;
    const schemaVersion = bundle?.schemaVersion ?? 1;
    const atomCount = bundle?.atomCount ?? 0;
    const sourceInputId = bundle?.sourceInputId ?? "n/a";
    const bundleStatus = bundle?.bundleStatus ?? "created";
    const applyErrorCode = bundle?.applyError?.code;
    const applyErrorMessage = bundle?.applyError?.message;
    const escapedTopicId = this.escapeHtml(topicId);
    const escapedBundleId = this.escapeHtml(bundleId);
    const escapedInputId = this.escapeHtml(sourceInputId);
    const escapedApplyErrorCode = applyErrorCode ? this.escapeHtml(applyErrorCode) : undefined;
    const escapedApplyErrorMessage = applyErrorMessage
      ? this.escapeHtml(applyErrorMessage)
      : undefined;

    return [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      "    <title>Pipeline Bundle Description</title>",
      "  </head>",
      "  <body>",
      `    <h1>Bundle ${escapedBundleId}</h1>`,
      "    <ul>",
      `      <li>Topic: ${escapedTopicId}</li>`,
      `      <li>Source draft version: ${effectiveDraftVersion}</li>`,
      `      <li>Schema version: ${schemaVersion}</li>`,
      `      <li>Atom count: ${atomCount}</li>`,
      `      <li>Source input: ${escapedInputId}</li>`,
      `      <li>Bundle status: ${bundleStatus}</li>`,
      ...(escapedApplyErrorCode
        ? [
          `      <li>Apply error code: ${escapedApplyErrorCode}</li>`,
          `      <li>Apply error message: ${escapedApplyErrorMessage ?? ""}</li>`,
        ]
        : []),
      "    </ul>",
      "  </body>",
      "</html>",
    ].join("\n");
  }

  private escapeHtml(value: string) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
}
