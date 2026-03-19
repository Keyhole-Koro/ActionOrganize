import { FieldValue, type Transaction } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type WorkspaceMetadataUpdate = {
  workspaceId: string;
  latestNodeSummary?: string;
  nodeCountIncrement?: number;
};

export class WorkspaceRepository {
  private readonly firestore = getFirestore();

  docRef(workspaceId: string) {
    return this.firestore.doc(`workspaces/${workspaceId}`);
  }

  writeMetadata(tx: Transaction, update: WorkspaceMetadataUpdate) {
    const data: any = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (update.latestNodeSummary) {
      data.latestNodeSummary = update.latestNodeSummary;
    }

    if (update.nodeCountIncrement) {
      data.nodeCount = FieldValue.increment(update.nodeCountIncrement);
    }

    tx.set(this.docRef(update.workspaceId), data, { merge: true });
  }

  async updateMetadata(update: WorkspaceMetadataUpdate) {
    const data: any = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (update.latestNodeSummary) {
      data.latestNodeSummary = update.latestNodeSummary;
    }

    if (update.nodeCountIncrement) {
      data.nodeCount = FieldValue.increment(update.nodeCountIncrement);
    }

    await this.docRef(update.workspaceId).set(data, { merge: true });
  }
}
