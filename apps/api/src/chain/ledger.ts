import { EVENT_TYPE_CODES, UNIT_CODES, type StoredEvent } from "@agro-cpr/spec";
import { eventIdToBytes32, ledgerKey } from "@agro-cpr/spec/keys";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { localMidnightUnix } from "../domain/dates.js";

export const ZERO32 = `0x${"0".repeat(64)}` as Hex;

/** Mirrors IAgroLedger.EventInput. */
export interface EventInput {
  subjectKey: Hex;
  eventId: Hex;
  eventType: number;
  unit: number;
  quantity: bigint;
  occurredAt: bigint;
  evidenceHash: Hex;
  refEventId: Hex;
  recordHash: Hex;
}

/** Mirrors IAgroLedger.CprInput. */
export interface CprInput {
  plotKey: Hex;
  seasonKey: Hex;
  producerKey: Hex;
  warehouseKey: Hex;
  eligibleKg: bigint;
  issuedKg: bigint;
  dueDate: bigint;
}

export interface AnchorReceipt {
  txHash: Hex | null; // null when the event was found already recorded
  blockNumber: bigint | null;
}

/** The subset of AgroLedger the relayer uses. */
export interface ChainAdapter {
  readonly chainId: number;
  issueCpr(cpr: CprInput, event: EventInput): Promise<AnchorReceipt>;
  settleCpr(tokenId: bigint, event: EventInput): Promise<AnchorReceipt>;
  recordEvent(event: EventInput): Promise<AnchorReceipt>;
  isRecorded(eventId: Hex): Promise<boolean>;
  headOf(subjectKey: Hex): Promise<{ seq: bigint; head: Hex }>;
}

const pair = [{ type: "bytes32" }, { type: "bytes32" }] as const;

/** Same as AgroLedger.cycleKeyFor: keccak256(abi.encode(plotKey, seasonKey)). */
export function cycleKeyFor(plotKey: Hex, seasonKey: Hex): Hex {
  return keccak256(encodeAbiParameters(pair, [plotKey, seasonKey]));
}

/** Same as the contract's hash chain: keccak256(abi.encode(previousHead, recordHash)). */
export function nextHead(previous: Hex, recordHash: Hex): Hex {
  return keccak256(encodeAbiParameters(pair, [previous, recordHash]));
}

export class LedgerKeys {
  constructor(private readonly secret: string) {}

  plot(plotId: string): Hex {
    return ledgerKey(this.secret, "plot", plotId) as Hex;
  }
  season(seasonCode: string): Hex {
    return ledgerKey(this.secret, "season", seasonCode) as Hex;
  }
  producer(orgId: string): Hex {
    return ledgerKey(this.secret, "producer", orgId) as Hex;
  }
  warehouse(orgId: string): Hex {
    return ledgerKey(this.secret, "warehouse", orgId) as Hex;
  }
  cycle(plotId: string, seasonCode: string): Hex {
    return cycleKeyFor(this.plot(plotId), this.season(seasonCode));
  }
  /** On-chain CPR token id as a decimal string. */
  tokenId(plotId: string, seasonCode: string): string {
    return BigInt(this.cycle(plotId, seasonCode)).toString();
  }
}

const hex32 = (hex: string | null): Hex => (hex ? (`0x${hex}` as Hex) : ZERO32);

export function toEventInput(body: StoredEvent, subjectKey: Hex, recordHash: string): EventInput {
  return {
    subjectKey,
    eventId: eventIdToBytes32(body.id) as Hex,
    eventType: EVENT_TYPE_CODES[body.eventType],
    unit: body.unit ? UNIT_CODES[body.unit] : UNIT_CODES.NONE,
    quantity: BigInt(body.quantity ?? 0),
    occurredAt: BigInt(Math.floor(Date.parse(body.occurredAt) / 1000)),
    evidenceHash: hex32(body.evidenceHash),
    refEventId: body.refEventId ? (eventIdToBytes32(body.refEventId) as Hex) : ZERO32,
    recordHash: hex32(recordHash),
  };
}

export function toCprInput(
  keys: LedgerKeys,
  body: Extract<StoredEvent, { eventType: "CPR_ISSUED" }>,
  cycle: { plotId: string; seasonCode: string; producerOrgId: string },
): CprInput {
  return {
    plotKey: keys.plot(cycle.plotId),
    seasonKey: keys.season(cycle.seasonCode),
    producerKey: keys.producer(cycle.producerOrgId),
    warehouseKey: keys.warehouse(body.payload.warehouseOrgId),
    eligibleKg: BigInt(body.payload.eligibleKg),
    issuedKg: BigInt(body.quantity),
    dueDate: BigInt(localMidnightUnix(body.payload.dueDate)),
  };
}
