import { describe, expect, it } from "vitest";
import { dedupeNodeIds, resolveNodeId } from "../src/services/cleaner-entity-resolution.js";

describe("cleaner entity resolution", () => {
  it("reuses existing node when normalized title matches", () => {
    const nodeId = resolveNodeId(
      [
        { nodeId: "node-existing", title: "Customer Success" },
        { nodeId: "node-other", title: "Roadmap" },
      ],
      "customer-success",
      "node-fallback",
    );

    expect(nodeId).toBe("node-existing");
  });

  it("falls back when no title match is found", () => {
    const nodeId = resolveNodeId(
      [{ nodeId: "node-existing", title: "Customer Success" }],
      "Security",
      "node-fallback",
    );

    expect(nodeId).toBe("node-fallback");
  });

  it("deduplicates node ids while keeping order", () => {
    const deduped = dedupeNodeIds(["root", "node-a", "node-a", "node-b"]);
    expect(deduped).toEqual(["root", "node-a", "node-b"]);
  });
});
