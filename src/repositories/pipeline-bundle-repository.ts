import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type PipelineBundleRecord = {
  workspaceId: string;
  topicId: string;
  bundleId: string;
  sourceDraftVersion: number;
  schemaVersion: number;
  atomCount: number;
  sourceInputId?: string;
  bundleStatus?: "created" | "applied" | "error";
  descStatus?: "pending" | "described" | "error";
};

export class PipelineBundleRepository {
  private readonly firestore = getFirestore();

  docRef(workspaceId: string, topicId: string, bundleId: string) {
    return this.firestore.doc(
      `workspaces/${workspaceId}/topics/${topicId}/pipelineBundles/${bundleId}`,
    );
  }

  async upsert(record: PipelineBundleRecord) {
    await this.docRef(record.workspaceId, record.topicId, record.bundleId).set(
      {
        topicId: record.topicId,
        bundleId: record.bundleId,
        sourceDraftVersion: record.sourceDraftVersion,
        schemaVersion: record.schemaVersion,
        atomCount: record.atomCount,
        sourceInputId: record.sourceInputId,
        bundleStatus: record.bundleStatus ?? "created",
        descStatus: record.descStatus ?? "pending",
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async markApplied(workspaceId: string, topicId: string, bundleId: string) {
    await this.docRef(workspaceId, topicId, bundleId).set(
      {
        bundleStatus: "applied",
        appliedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async markDescribed(workspaceId: string, topicId: string, bundleId: string, descRef: string) {
    await this.docRef(workspaceId, topicId, bundleId).set(
      {
        descStatus: "described",
        descRef,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
