import { keccak256, toHex, type Hex } from "viem";
import { cycleKeyFor, nextHead, ZERO32, type AnchorReceipt, type ChainAdapter, type CprInput, type EventInput } from "./ledger.js";

const CPR_ISSUED = 3;
const CPR_SETTLED = 16;

/**
 * In-memory stand-in for AgroLedger with the same checks and hash chain.
 * State is lost on restart, so use it for local development and tests only.
 */
export function createMockChain(): ChainAdapter & { reset(): void } {
  let recorded = new Map<Hex, Hex>(); // eventId -> subjectKey
  let heads = new Map<Hex, { seq: bigint; head: Hex }>();
  let cprs = new Map<bigint, { issuedKg: bigint; eligibleKg: bigint; settled: boolean }>();
  let block = 0n;

  function receipt(): AnchorReceipt {
    block += 1n;
    return { txHash: keccak256(toHex(`mock-tx-${block}`)), blockNumber: block };
  }

  function record(e: EventInput): void {
    if (recorded.has(e.eventId)) throw new Error(`EventAlreadyRecorded(${e.eventId})`);
    if (e.refEventId !== ZERO32) {
      const refSubject = recorded.get(e.refEventId);
      if (!refSubject) throw new Error("InvalidEventInput: reference not anchored");
      if (refSubject !== e.subjectKey) throw new Error("EventSubjectMismatch");
    }
    recorded.set(e.eventId, e.subjectKey);
    const h = heads.get(e.subjectKey) ?? { seq: 0n, head: ZERO32 };
    heads.set(e.subjectKey, { seq: h.seq + 1n, head: nextHead(h.head, e.recordHash) });
  }

  return {
    chainId: 31337,
    reset() {
      recorded = new Map();
      heads = new Map();
      cprs = new Map();
      block = 0n;
    },
    async issueCpr(cpr: CprInput, e: EventInput) {
      if (cpr.issuedKg > cpr.eligibleKg) throw new Error("IssuedAboveEligible");
      const cycleKey = cycleKeyFor(cpr.plotKey, cpr.seasonKey);
      const tokenId = BigInt(cycleKey);
      if (cprs.has(tokenId)) throw new Error(`CprAlreadyExists(${tokenId})`);
      if (e.eventType !== CPR_ISSUED || e.subjectKey !== cycleKey) throw new Error("EventTypeMismatch/EventSubjectMismatch");
      record(e);
      cprs.set(tokenId, { issuedKg: cpr.issuedKg, eligibleKg: cpr.eligibleKg, settled: false });
      return receipt();
    },
    async settleCpr(tokenId: bigint, e: EventInput) {
      const c = cprs.get(tokenId);
      if (!c || c.settled) throw new Error(`CprNotIssued(${tokenId})`);
      if (e.eventType !== CPR_SETTLED) throw new Error("EventTypeMismatch");
      record(e);
      c.settled = true;
      return receipt();
    },
    async recordEvent(e: EventInput) {
      if (e.eventType === CPR_ISSUED || e.eventType === CPR_SETTLED) throw new Error("ReservedEventType");
      record(e);
      return receipt();
    },
    async isRecorded(eventId: Hex) {
      return recorded.has(eventId);
    },
    async headOf(subjectKey: Hex) {
      return heads.get(subjectKey) ?? { seq: 0n, head: ZERO32 };
    },
  };
}
