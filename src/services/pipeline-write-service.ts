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

    if (!this.isFirestoreBackend()) {
      return {
        outlineVersion: sourceDraftVersion,
        changedNodeIds: [rootNodeId],
        descRef,
        reissuedAtomIds: [],
      };
    }

    const bundle = await this.bundleRepository.get(envelope.workspaceId, envelope.topicId, bundleId);
    const descHtml = this.toBundleDescHtml(envelope.topicId, bundleId, sourceDraftVersion, bundle);
    const sourceAtomIds = bundle?.sourceAtomIds ?? [];
    const atoms = sourceAtomIds.length
      ? await this.atomRepository.getByIds(envelope.workspaceId, envelope.topicId, sourceAtomIds)
      : [];
    const reissuedAtomIds = atoms
      .filter((atom) => atom.confidence < 0.5 || atom.claim.trim().length === 0)
      .map((atom) => atom.atomId);
    const candidateAtoms = atoms.filter((atom) => !reissuedAtomIds.includes(atom.atomId));
    const candidateNodeIds = candidateAtoms.map((atom) => this.toAtomNodeId(envelope.topicId, atom.atomId));
    const changedNodeIds = [rootNodeId, ...candidateNodeIds];

    try {
      await this.bundleDescriptionRepository.writeHtml(descRef, descHtml);
    } catch (error) {
      throw new TemporaryDependencyError(
        `failed to write bundle description: ${error instanceof Error ? error.message : "unknown error"}`,
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
        summaryMd: this.toOutlineSummary(envelope.topicId, bundleId, sourceDraftVersion),
        mapMd: this.toOutlineMap(envelope.topicId, rootNodeId),
      });

      tx.set(
        topicRef,
        {
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          latestOutlineVersion: nextOutlineVersion,
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

      for (const atom of candidateAtoms) {
        const atomNodeId = this.toAtomNodeId(envelope.topicId, atom.atomId);
        this.nodeRepository.write(tx, {
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          nodeId: atomNodeId,
          kind: "claim",
          title: atom.title,
          parentId: rootNodeId,
          schemaVersion,
          contextSummary: atom.claim,
        });
        this.edgeRepository.write(tx, {
          workspaceId: envelope.workspaceId,
          topicId: envelope.topicId,
          edgeId: this.toEdgeId(rootNodeId, atomNodeId),
          sourceNodeId: rootNodeId,
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

    await topicRef.set(
      {
        latestMapVersion: outlineVersion,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async onNodeRollupRequested(
    envelope: EventEnvelope,
    nodeId: string,
    generation: number,
  ): Promise<{ topicId: string; nodeId: string }> {
    if (!this.isFirestoreBackend()) {
      return { topicId: envelope.topicId, nodeId };
    }

    await this.nodeRepository.upsert({
      workspaceId: envelope.workspaceId,
      topicId: envelope.topicId,
      nodeId,
      kind: "topic",
      title: nodeId,
      rollupRef: `mind/node_rollup/${nodeId}/v${generation}.html`,
      rollupWatermark: generation,
      contextSummary: `Rollup generated for ${nodeId} at generation ${generation}`,
      detailHtml: `<section><h1>${nodeId}</h1><p>Rollup generation ${generation}</p></section>`,
    });

    return { topicId: envelope.topicId, nodeId };
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

      tx.set(
        topicRef,
        {
          schemaVersion,
          updatedAt: FieldValue.serverTimestamp(),
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

  private toOutlineMap(topicId: string, rootNodeId: string) {
    return [
      `# Map ${topicId}`,
      "",
      `- ${rootNodeId}`,
    ].join("\n");
  }

  private toBundleDescRef(bundleId: string, version: number) {
    return `mind/bundle_desc/${bundleId}/v${version}.html`;
  }

  private toAtomNodeId(topicId: string, atomId: string) {
    return `node:${topicId}:atom:${atomId}`;
  }

  private toEdgeId(sourceNodeId: string, targetNodeId: string) {
    return `edge:${sourceNodeId}->${targetNodeId}`;
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
    const escapedTopicId = this.escapeHtml(topicId);
    const escapedBundleId = this.escapeHtml(bundleId);
    const escapedInputId = this.escapeHtml(sourceInputId);

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
