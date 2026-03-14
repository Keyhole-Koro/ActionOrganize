import { env } from "../config/env.js";
import type { EventLedgerPort, LeasePort } from "./contracts.js";
import { EventLedgerRepository } from "./event-ledger-repository.js";
import { LeaseRepository } from "./lease-repository.js";
import { MemoryEventLedgerRepository } from "./memory-event-ledger-repository.js";
import { MemoryLeaseRepository } from "./memory-lease-repository.js";

export function createEventLedgerRepository(): EventLedgerPort {
  return env.STATE_BACKEND === "firestore"
    ? new EventLedgerRepository()
    : new MemoryEventLedgerRepository();
}

export function createLeaseRepository(): LeasePort {
  return env.STATE_BACKEND === "firestore" ? new LeaseRepository() : new MemoryLeaseRepository();
}
