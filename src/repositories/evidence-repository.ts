import { FieldValue } from "@google-cloud/firestore";
import { getFirestore } from "../core/firestore.js";

export type EvidenceRecord = {
    workspaceId: string;
    topicId: string;
    nodeId: string;
    evidenceId: string;
    sourceAtomId: string;
    sourceInputId: string;
    claim: string;
    kind: string;
    confidence: number;
    schemaVersion?: number;
    sourceAssetRefs?: Array<{
        assetId: string;
        messageId: string;
        kind: string;
        mimeType: string;
        gcsUri: string;
        downloadUrl?: string;
        originalPath: string;
    }>;
};

export class EvidenceRepository {
    private readonly firestore = getFirestore();

    docRef(workspaceId: string, nodeId: string, evidenceId: string) {
        return this.firestore.doc(
            `workspaces/${workspaceId}/nodes/${nodeId}/evidence/${evidenceId}`,
        );
    }

    async upsert(record: EvidenceRecord) {
        await this.docRef(record.workspaceId, record.nodeId, record.evidenceId).set(
            {
                topicId: record.topicId,
                nodeId: record.nodeId,
                evidenceId: record.evidenceId,
                sourceAtomId: record.sourceAtomId,
                sourceInputId: record.sourceInputId,
                claim: record.claim,
                kind: record.kind,
                confidence: record.confidence,
                schemaVersion: record.schemaVersion,
                sourceAssetRefs: record.sourceAssetRefs,
                updatedAt: FieldValue.serverTimestamp(),
                createdAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
        );
    }

    async countByNode(workspaceId: string, nodeId: string): Promise<number> {
        const snapshot = await this.firestore
            .collection(
                `workspaces/${workspaceId}/nodes/${nodeId}/evidence`,
            )
            .count()
            .get();
        return snapshot.data().count;
    }
}
