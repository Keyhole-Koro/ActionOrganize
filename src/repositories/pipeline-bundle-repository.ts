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

export type PipelineBundleSnapshot = {
  bundleId: string;
  topicId: string;
  sourceDraftVersion: number;
  schemaVersion: number;
  atomCount: number;
  sourceInputId?: string;
  bundleStatus: "created" | "applied" | "error";
  descStatus: "pending" | "described" | "error";
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
        describedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async get(
    workspaceId: string,
    topicId: string,
    bundleId: string,
  ): Promise<PipelineBundleSnapshot | null> {
    const snapshot = await this.docRef(workspaceId, topicId, bundleId).get();
    if (!snapshot.exists) {
      return null;
    }

    const sourceDraftVersion = snapshot.get("sourceDraftVersion");
    const schemaVersion = snapshot.get("schemaVersion");
    const atomCount = snapshot.get("atomCount");
    const sourceInputId = snapshot.get("sourceInputId");
    const bundleStatus = snapshot.get("bundleStatus");
    const descStatus = snapshot.get("descStatus");

    return {
      bundleId,
      topicId,
      sourceDraftVersion: typeof sourceDraftVersion === "number" ? sourceDraftVersion : 1,
      schemaVersion: typeof schemaVersion === "number" ? schemaVersion : 1,
      atomCount: typeof atomCount === "number" ? atomCount : 0,
      sourceInputId: typeof sourceInputId === "string" ? sourceInputId : undefined,
      bundleStatus:
        bundleStatus === "applied" || bundleStatus === "error" ? bundleStatus : "created",
      descStatus:
        descStatus === "described" || descStatus === "error" ? descStatus : "pending",
    };
  }
}
