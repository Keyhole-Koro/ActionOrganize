import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type PipelineBundleRecord = {
  workspaceId: string;
  topicId: string;
  bundleId: string;
  sourceDraftVersion: number;
  schemaVersion: number;
  atomCount: number;
  sourceAtomIds?: string[];
  sourceInputId?: string;
  bundleStatus?: "created" | "applying" | "applied" | "error";
  descStatus?: "pending" | "described" | "error";
};

export type PipelineBundleSnapshot = {
  bundleId: string;
  topicId: string;
  sourceDraftVersion: number;
  schemaVersion: number;
  atomCount: number;
  sourceAtomIds: string[];
  sourceInputId?: string;
  bundleStatus: "created" | "applying" | "applied" | "error";
  descStatus: "pending" | "described" | "error";
  appliedAt?: unknown;
  descVersion: number;
};

export class PipelineBundleRepository {
  private readonly firestore = getFirestore();

  private toMillis(value: unknown): number | null {
    if (value instanceof Timestamp) {
      return value.toMillis();
    }
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === "number") {
      return value;
    }
    return null;
  }

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
        sourceAtomIds: record.sourceAtomIds,
        sourceInputId: record.sourceInputId,
        bundleStatus: record.bundleStatus ?? "created",
        descStatus: record.descStatus ?? "pending",
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async markApplied(workspaceId: string, topicId: string, bundleId: string): Promise<boolean> {
    const ref = this.docRef(workspaceId, topicId, bundleId);
    return this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.get("appliedAt")) {
        return false;
      }
      tx.set(
        ref,
        {
          bundleStatus: "applied",
          appliedAt: FieldValue.serverTimestamp(),
          applyingAt: FieldValue.delete(),
          applyingTraceId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return true;
    });
  }

  async tryStartApply(
    workspaceId: string,
    topicId: string,
    bundleId: string,
    traceId: string,
    staleAfterMs: number,
  ): Promise<boolean> {
    const ref = this.docRef(workspaceId, topicId, bundleId);
    return this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.get("appliedAt")) {
        return false;
      }
      const status = snapshot.get("bundleStatus");
      if (status === "applying") {
        const applyingAtMillis = this.toMillis(snapshot.get("applyingAt"));
        if (typeof applyingAtMillis !== "number") {
          return false;
        }
        if (Date.now() - applyingAtMillis < staleAfterMs) {
          return false;
        }
      }
      tx.set(
        ref,
        {
          bundleStatus: "applying",
          applyingAt: FieldValue.serverTimestamp(),
          applyingTraceId: traceId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return true;
    });
  }

  async markApplyFailed(
    workspaceId: string,
    topicId: string,
    bundleId: string,
    errorCode: string,
    message: string,
  ): Promise<void> {
    await this.docRef(workspaceId, topicId, bundleId).set(
      {
        bundleStatus: "error",
        applyError: {
          code: errorCode,
          message,
        },
        applyingAt: FieldValue.delete(),
        applyingTraceId: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  async markDescribed(
    workspaceId: string,
    topicId: string,
    bundleId: string,
    descRef: string,
  ): Promise<number> {
    const ref = this.docRef(workspaceId, topicId, bundleId);
    return this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const currentVersion =
        typeof snapshot.get("descVersion") === "number" ? snapshot.get("descVersion") : 0;
      const currentRef = snapshot.get("descRef");
      const nextVersion = currentRef === descRef ? currentVersion : currentVersion + 1;
      tx.set(
        ref,
        {
          descStatus: "described",
          descRef,
          descVersion: nextVersion,
          describedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return nextVersion;
    });
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
    const sourceAtomIds = snapshot.get("sourceAtomIds");
    const sourceInputId = snapshot.get("sourceInputId");
    const bundleStatus = snapshot.get("bundleStatus");
    const descStatus = snapshot.get("descStatus");
    const appliedAt = snapshot.get("appliedAt");
    const descVersion = snapshot.get("descVersion");

    return {
      bundleId,
      topicId,
      sourceDraftVersion: typeof sourceDraftVersion === "number" ? sourceDraftVersion : 1,
      schemaVersion: typeof schemaVersion === "number" ? schemaVersion : 1,
      atomCount: typeof atomCount === "number" ? atomCount : 0,
      sourceAtomIds: Array.isArray(sourceAtomIds)
        ? sourceAtomIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [],
      sourceInputId: typeof sourceInputId === "string" ? sourceInputId : undefined,
      bundleStatus:
        bundleStatus === "applying" || bundleStatus === "applied" || bundleStatus === "error"
          ? bundleStatus
          : "created",
      descStatus:
        descStatus === "described" || descStatus === "error" ? descStatus : "pending",
      appliedAt,
      descVersion: typeof descVersion === "number" ? descVersion : 0,
    };
  }
}
