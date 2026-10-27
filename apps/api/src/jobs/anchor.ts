import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Hex } from "viem";
import { nextHead, toCprInput, toEventInput, ZERO32, type AnchorReceipt, type ChainAdapter, type LedgerKeys } from "../chain/ledger.js";
import type { Db } from "../db/client.js";
import { cropCycles, events } from "../db/schema.js";
import { raiseAlert, resolveAlert } from "../services/alerts.js";
import type { EventRow } from "../services/events.js";

export const MAX_ANCHOR_ATTEMPTS = 5;

interface SubjectRef {
  key: Hex;
  cycle: { plotId: string; seasonCode: string; producerOrgId: string } | null;
}

function subjectResolver(db: Db, keys: LedgerKeys) {
  const cache = new Map<string, SubjectRef>();
  return async (row: Pick<EventRow, "subjectType" | "subjectId">): Promise<SubjectRef> => {
    const hit = cache.get(row.subjectId);
    if (hit) return hit;
    let ref: SubjectRef;
    if (row.subjectType === "PLOT") {
      ref = { key: keys.plot(row.subjectId), cycle: null };
    } else {
      const [cycle] = await db.select().from(cropCycles).where(eq(cropCycles.id, row.subjectId));
      if (!cycle) throw new Error(`Crop cycle ${row.subjectId} not found`);
      ref = { key: keys.cycle(cycle.plotId, cycle.seasonCode), cycle };
    }
    cache.set(row.subjectId, ref);
    return ref;
  };
}

/**
 * Sends pending events to the chain, one transaction each, in insertion order.
 * A failure blocks the rest of that subject's events (the hash chain and
 * corrections depend on order) but not other subjects.
 */
export async function anchorPending(
  db: Db,
  chain: ChainAdapter,
  keys: LedgerKeys,
  opts: { now: () => Date; limit?: number },
): Promise<{ anchored: number; failed: number; skipped: number }> {
  const rows = await db
    .select()
    .from(events)
    .where(and(inArray(events.anchorStatus, ["PENDING", "FAILED"]), lt(events.anchorAttempts, MAX_ANCHOR_ATTEMPTS)))
    .orderBy(asc(events.seq))
    .limit(opts.limit ?? 50);
  const stuck = await db
    .selectDistinct({ subjectId: events.subjectId })
    .from(events)
    .where(and(eq(events.anchorStatus, "FAILED"), gte(events.anchorAttempts, MAX_ANCHOR_ATTEMPTS)));
  const blocked = new Set(stuck.map((s) => s.subjectId));
  const resolve = subjectResolver(db, keys);
  const counts = { anchored: 0, failed: 0, skipped: 0 };

  for (const row of rows) {
    if (blocked.has(row.subjectId)) {
      counts.skipped += 1;
      continue;
    }
    try {
      const subject = await resolve(row);
      const input = toEventInput(row.body, subject.key, row.recordHash);
      let receipt: AnchorReceipt;
      if (await chain.isRecorded(input.eventId)) {
        // A previous attempt landed but its result was lost (e.g. a timeout).
        receipt = { txHash: null, blockNumber: null };
      } else if (row.body.eventType === "CPR_ISSUED") {
        if (!subject.cycle) throw new Error("CPR_ISSUED on a non-cycle subject");
        receipt = await chain.issueCpr(toCprInput(keys, row.body, subject.cycle), input);
      } else if (row.body.eventType === "CPR_SETTLED") {
        receipt = await chain.settleCpr(BigInt(subject.key), input);
      } else {
        receipt = await chain.recordEvent(input);
      }
      await db
        .update(events)
        .set({
          anchorStatus: "ANCHORED",
          anchorError: null,
          chainId: chain.chainId,
          txHash: receipt.txHash,
          blockNumber: receipt.blockNumber === null ? null : Number(receipt.blockNumber),
          anchoredAt: opts.now(),
        })
        .where(eq(events.id, row.id));
      counts.anchored += 1;
    } catch (err) {
      blocked.add(row.subjectId);
      const attempts = row.anchorAttempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(events)
        .set({ anchorStatus: "FAILED", anchorAttempts: attempts, anchorError: message.slice(0, 2000) })
        .where(eq(events.id, row.id));
      if (attempts >= MAX_ANCHOR_ATTEMPTS) {
        await raiseAlert(
          db,
          {
            type: "ANCHOR_FAILED",
            severity: "HIGH",
            dedupeKey: `ANCHOR_FAILED:${row.id}`,
            cropCycleId: row.subjectType === "CROP_CYCLE" ? row.subjectId : null,
            subjectId: row.subjectId,
            eventId: row.id,
            message: `${row.eventType} could not be anchored after ${attempts} attempts: ${message.slice(0, 300)}`,
          },
          opts.now(),
        );
      }
      counts.failed += 1;
    }
  }
  return counts;
}

/**
 * Recomputes each subject's hash chain from Postgres and compares it with the
 * contract. A mismatch means a bug or a compromised relayer key.
 */
export async function reconcileAnchors(
  db: Db,
  chain: ChainAdapter,
  keys: LedgerKeys,
  opts: { now: () => Date },
): Promise<{ subjects: number; mismatches: string[] }> {
  const rows = await db
    .select({ subjectId: events.subjectId, subjectType: events.subjectType, recordHash: events.recordHash })
    .from(events)
    .where(eq(events.anchorStatus, "ANCHORED"))
    .orderBy(asc(events.seq));

  const bySubject = new Map<string, { subjectType: EventRow["subjectType"]; seq: bigint; head: Hex }>();
  for (const r of rows) {
    const s = bySubject.get(r.subjectId) ?? { subjectType: r.subjectType, seq: 0n, head: ZERO32 };
    s.seq += 1n;
    s.head = nextHead(s.head, `0x${r.recordHash}`);
    bySubject.set(r.subjectId, s);
  }

  const resolve = subjectResolver(db, keys);
  const mismatches: string[] = [];
  for (const [subjectId, expected] of bySubject) {
    const subject = await resolve({ subjectId, subjectType: expected.subjectType });
    const actual = await chain.headOf(subject.key);
    const dedupeKey = `ANCHOR_MISMATCH:${subjectId}`;
    if (actual.seq !== expected.seq || actual.head !== expected.head) {
      mismatches.push(subjectId);
      await raiseAlert(
        db,
        {
          type: "ANCHOR_FAILED",
          severity: "HIGH",
          dedupeKey,
          cropCycleId: expected.subjectType === "CROP_CYCLE" ? subjectId : null,
          subjectId,
          eventId: null,
          message: `On-chain history differs from the database (chain seq ${actual.seq}, database ${expected.seq})`,
        },
        opts.now(),
      );
    } else {
      await resolveAlert(db, dedupeKey, opts.now());
    }
  }
  return { subjects: bySubject.size, mismatches };
}
