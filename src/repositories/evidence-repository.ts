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
};

export class EvidenceRepository {
    private readonly firestore = getFirestore();

    docRef(workspaceId: string, topicId: string, nodeId: string, evidenceId: string) {
        return this.firestore.doc(
            `workspaces/${workspaceId}/topics/${topicId}/nodes/${nodeId}/evidence/${evidenceId}`,
        );
    }

    async upsert(record: EvidenceRecord) {
        await this.docRef(record.workspaceId, record.topicId, record.nodeId, record.evidenceId).set(
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
                updatedAt: FieldValue.serverTimestamp(),
                createdAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
        );
    }

    async countByNode(workspaceId: string, topicId: string, nodeId: string): Promise<number> {
        const snapshot = await this.firestore
            .collection(
                `workspaces/${workspaceId}/topics/${topicId}/nodes/${nodeId}/evidence`,
            )
            .count()
            .get();
        return snapshot.data().count;
    }
}
