import { env } from "../config/env.js";
import { TemporaryDependencyError } from "../core/errors.js";
import type { LeasePort } from "./contracts.js";

type LeaseState = {
  owner: string;
  expiresAt: number;
};

const leases = new Map<string, LeaseState>();

function leaseKey(workspaceId: string, resourceKey: string) {
  return `${workspaceId}:${resourceKey}`;
}

export class MemoryLeaseRepository implements LeasePort {
  async acquire(workspaceId: string, _topicId: string, resourceKey: string, owner: string): Promise<void> {
    const key = leaseKey(workspaceId, resourceKey);
    const now = Date.now();
    const current = leases.get(key);
    if (current && current.expiresAt > now) {
      throw new TemporaryDependencyError(`lease busy for ${resourceKey}`);
    }
    leases.set(key, {
      owner,
      expiresAt: now + env.LEASE_TTL_SECONDS * 1000,
    });
  }

  async release(workspaceId: string, resourceKey: string, owner: string): Promise<void> {
    const key = leaseKey(workspaceId, resourceKey);
    const current = leases.get(key);
    if (current?.owner === owner) {
      leases.delete(key);
    }
  }
}
