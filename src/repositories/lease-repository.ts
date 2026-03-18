import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { env } from "../config/env.js";
import { EventInProgressError } from "../core/errors.js";
import { getFirestore } from "../core/firestore.js";
import type { LeasePort } from "./contracts.js";

export class LeaseRepository implements LeasePort {
  private readonly firestore = getFirestore();

  private docRef(workspaceId: string, resourceKey: string) {
    return this.firestore.doc(`workspaces/${workspaceId}/leases/${resourceKey}`);
  }

  async acquire(workspaceId: string, topicId: string, resourceKey: string, owner: string) {
    const ref = this.docRef(workspaceId, resourceKey);

    await this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const now = Timestamp.now();

      if (snapshot.exists) {
        const expiresAt = snapshot.get("expiresAt");
        if (expiresAt instanceof Timestamp && expiresAt.toMillis() > now.toMillis()) {
          throw new EventInProgressError(`lease busy for ${resourceKey}`);
        }
      }

      tx.set(
        ref,
        {
          topicId,
          owner,
          acquiredAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(now.toMillis() + env.LEASE_TTL_SECONDS * 1000),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }

  async release(workspaceId: string, resourceKey: string, owner: string) {
    await this.docRef(workspaceId, resourceKey).set(
      {
        owner,
        expiresAt: Timestamp.fromMillis(0),
        releasedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
