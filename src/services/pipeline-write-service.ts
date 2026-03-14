import { FieldValue } from "@google-cloud/firestore";
import { env } from "../config/env.js";
import type { EventEnvelope } from "../models/envelope.js";
import { IndexItemRepository } from "../repositories/index-item-repository.js";
import { InputProgressRepository } from "../repositories/input-progress-repository.js";
import { NodeRepository } from "../repositories/node-repository.js";
import { OutlineRepository } from "../repositories/outline-repository.js";
import { PipelineBundleRepository } from "../repositories/pipeline-bundle-repository.js";
import { TopicRepository } from "../repositories/topic-repository.js";
import { BundleDescriptionRepository } from "../repositories/bundle-description-repository.js";

type DraftBundleResult = {
  bundleId: string;
  schemaVersion: number;
};

type OutlineApplyResult = {
  outlineVersion: number;
  changedNodeIds: string[];
};

export class PipelineWriteService {
  private readonly topicRepository = new TopicRepository();
  private readonly bundleRepository = new PipelineBundleRepository();
  private readonly outlineRepository = new OutlineRepository();
  private readonly nodeRepository = new NodeRepository();
  private readonly indexItemRepository = new IndexItemRepository();
  private readonly inputProgressRepository = new InputProgressRepository();
  private readonly bundleDescriptionRepository = new BundleDescriptionRepository();

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
    const changedNodeIds = [rootNodeId];
    const descRef = this.toBundleDescRef(bundleId, sourceDraftVersion);
    const descHtml = this.toBundleDescHtml(envelope.topicId, bundleId, sourceDraftVersion);

    if (!this.isFirestoreBackend()) {
      return { outlineVersion: sourceDraftVersion, changedNodeIds };
    }

    await this.bundleDescriptionRepository.writeHtml(descRef, descHtml);

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

      return nextOutlineVersion;
    });

    await this.bundleRepository.markApplied(envelope.workspaceId, envelope.topicId, bundleId);
    await this.bundleRepository.markDescribed(
      envelope.workspaceId,
      envelope.topicId,
      bundleId,
      descRef,
    );

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

    return { outlineVersion, changedNodeIds };
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
  ) {
    if (!this.isFirestoreBackend()) {
      return;
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

  private toBundleDescHtml(topicId: string, bundleId: string, sourceDraftVersion: number) {
    return [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      "    <title>Pipeline Bundle Description</title>",
      "  </head>",
      "  <body>",
      `    <h1>Bundle ${bundleId}</h1>`,
      `    <p>Topic: ${topicId}</p>`,
      `    <p>Source draft version: ${sourceDraftVersion}</p>`,
      "  </body>",
      "</html>",
    ].join("\n");
  }
}
