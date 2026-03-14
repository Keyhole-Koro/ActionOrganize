import { describe, expect, it } from "vitest";
import { dedupeNodeIds, resolveNode } from "../src/services/cleaner-entity-resolution.js";

describe("cleaner entity resolution", () => {
  it("reuses existing node when normalized title matches", () => {
    const resolved = resolveNode(
      [
        { nodeId: "node-existing", title: "Customer Success", contextSummary: "CS operations", schemaVersion: 3 },
        { nodeId: "node-other", title: "Roadmap", contextSummary: "planning", schemaVersion: 3 },
      ],
      {
        atomTitle: "customer-success",
        atomClaim: "customer success operations",
        fallbackNodeId: "node-fallback",
        schemaVersion: 3,
      },
    );

    expect(resolved.nodeId).toBe("node-existing");
    expect(resolved.isMerged).toBe(true);
  });

  it("falls back when no title match is found", () => {
    const resolved = resolveNode(
      [{ nodeId: "node-existing", title: "Customer Success", contextSummary: "cx", schemaVersion: 2 }],
      {
        atomTitle: "Security",
        atomClaim: "infrastructure hardening",
        fallbackNodeId: "node-fallback",
        schemaVersion: 2,
      },
    );

    expect(resolved.nodeId).toBe("node-fallback");
    expect(resolved.isMerged).toBe(false);
  });

  it("falls back when schema version is incompatible", () => {
    const resolved = resolveNode(
      [{ nodeId: "node-existing", title: "Security", contextSummary: "hardening", schemaVersion: 1 }],
      {
        atomTitle: "Security",
        atomClaim: "hardening",
        fallbackNodeId: "node-fallback",
        schemaVersion: 2,
      },
    );

    expect(resolved.nodeId).toBe("node-fallback");
    expect(resolved.isMerged).toBe(false);
  });

  it("deduplicates node ids while keeping order", () => {
    const deduped = dedupeNodeIds(["root", "node-a", "node-a", "node-b"]);
    expect(deduped).toEqual(["root", "node-a", "node-b"]);
  });
});
