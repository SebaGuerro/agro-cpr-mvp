import { createHash, createHmac } from "node:crypto";
import type { StoredEvent } from "./events.js";

// Server-side only: never ship LEDGER_KEY_SECRET to the browser.
// Keys are HMACs of internal UUIDs (never CPF/CNPJ), so the chain reveals nothing
// about who is who. The secret must not rotate during the pilot, or keys change.

export type Hex32 = `0x${string}`;
export type KeyDomain = "producer" | "plot" | "warehouse" | "season";

export function ledgerKey(secret: string, domain: KeyDomain, value: string): Hex32 {
  return `0x${createHmac("sha256", secret).update(`${domain}:${value}`).digest("hex")}`;
}

// cycleKey = keccak256(abi.encode(plotKey, seasonKey)) is computed by the contract
// (IAgroLedger.cycleKeyFor) so CPR uniqueness per (plot, season) is enforced on-chain.

// Event UUID as bytes32: its 16 bytes left-aligned, zero-padded. Reversible, no hashing.
export function eventIdToBytes32(uuid: string): Hex32 {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Invalid UUID: ${uuid}`);
  return `0x${hex}${"0".repeat(32)}`;
}

// RFC 8785 (JCS) for the JSON we produce: plain objects, arrays, strings,
// finite numbers, booleans and null. Keys sorted by UTF-16 code units.
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Non-finite number in canonical JSON");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function recordHash(event: StoredEvent): string {
  return createHash("sha256").update(canonicalJson(event)).digest("hex");
}
