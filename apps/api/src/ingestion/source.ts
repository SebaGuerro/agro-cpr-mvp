import { createHash } from "node:crypto";
import { ApiError } from "../domain/errors.js";
import type { ImportRowError } from "../db/schema.js";
import { cellText, localDateTime, normalizeHeader, parseBool, parseDate, parseNumber, parseTime, type Cell, type Sheet } from "./parse.js";

/**
 * Where an event's data came from. MANUAL: typed in the app. IMPORTED: a file
 * someone uploaded. VERIFIED: read from a system of record (SEFAZ NF-e, a
 * registry, machine telemetry). Today only MANUAL and IMPORTED exist.
 */
export type Provenance = "MANUAL" | "IMPORTED" | "VERIFIED";

export interface SourceRow {
  /** Row number as the user sees it (the Excel row). */
  n: number;
  values: Map<string, Cell>;
}

/**
 * The port every inbound feed implements. A source only yields rows keyed by
 * column; mapping rows to canonical events and validating them is shared, so
 * a future digital-twin or NF-e feed goes through the same rules as a spreadsheet
 * and as manual entry.
 */
export interface IngestionSource {
  readonly name: string;
  readonly provenance: Provenance;
  rows(): Iterable<SourceRow>;
}

export interface Column {
  /** Normalized header (see normalizeHeader). */
  key: string;
  /** Header written in the template. */
  header: string;
  /** The column must be present, and the cell filled. */
  required: boolean;
  format: string;
  example: string;
  help: string;
  /** Fixed values offered as a dropdown. */
  options?: readonly string[];
  /** Dropdown taken from a list on the reference sheet. */
  ref?: "plots" | "seasons" | "farms" | "checklist" | "evidence";
  aliases?: string[];
}

/** Maps sheet columns to keys. Unknown columns (like "erro" from an annotated file) are ignored. */
export function spreadsheetSource(sheet: Sheet, columns: Column[]): IngestionSource {
  const byName = new Map<string, string>();
  for (const c of columns) {
    for (const name of [c.key, c.header, ...(c.aliases ?? [])]) byName.set(normalizeHeader(name), c.key);
  }
  const positions = new Map<string, number>();
  sheet.headers.forEach((h, i) => {
    const key = byName.get(normalizeHeader(h));
    if (key && !positions.has(key)) positions.set(key, i);
  });
  const missing = columns.filter((c) => c.required && !positions.has(c.key));
  if (missing.length) {
    throw new ApiError(
      "VALIDATION_FAILED",
      `Faltam colunas obrigatórias: ${missing.map((c) => c.header).join(", ")}. Baixe o modelo em /v1/imports/templates.`,
      missing.map((c) => ({ path: c.key, message: `Coluna "${c.header}" não encontrada` })),
    );
  }
  return {
    name: "SPREADSHEET",
    provenance: "IMPORTED",
    *rows() {
      for (const r of sheet.rows) {
        const values = new Map<string, Cell>();
        for (const [key, i] of positions) values.set(key, r.cells[i] ?? null);
        yield { n: r.n, values };
      }
    },
  };
}

/**
 * Deterministic UUID (version 8) from a row's natural key, so uploading the same
 * row twice is idempotent and a changed row is reported instead of duplicated.
 */
export function importId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u001f")).digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Reads typed values from one row and collects every problem instead of stopping at the first. */
export class RowReader {
  readonly errors: ImportRowError[] = [];
  private readonly cols: Map<string, Column>;

  constructor(
    readonly row: SourceRow,
    columns: Column[],
  ) {
    this.cols = new Map(columns.map((c) => [c.key, c]));
  }

  get n(): number {
    return this.row.n;
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }

  error(column: string | undefined, message: string): null {
    this.errors.push({ row: this.n, ...(column && { column: this.cols.get(column)?.header ?? column }), message });
    return null;
  }

  has(key: string): boolean {
    return cellText(this.row.values.get(key) ?? null) !== null;
  }

  raw(key: string): Cell {
    return this.row.values.get(key) ?? null;
  }

  private present(key: string, required?: boolean): Cell {
    const v = this.raw(key);
    if (cellText(v) === null) {
      if (required ?? this.cols.get(key)?.required) this.error(key, "Obrigatório");
      return null;
    }
    return v;
  }

  text(key: string, opts: { required?: boolean; max?: number } = {}): string | null {
    const v = this.present(key, opts.required);
    if (v === null) return null;
    const s = cellText(v)!;
    if (opts.max && s.length > opts.max) return this.error(key, `Máximo de ${opts.max} caracteres`);
    return s;
  }

  decimal(key: string, opts: { required?: boolean; min?: number; max?: number } = {}): number | null {
    const v = this.present(key, opts.required);
    if (v === null) return null;
    const x = parseNumber(v);
    if (x === null) return this.error(key, `Número inválido: "${v}"`);
    if (opts.min !== undefined && x < opts.min) return this.error(key, `Deve ser no mínimo ${opts.min}`);
    if (opts.max !== undefined && x > opts.max) return this.error(key, `Deve ser no máximo ${opts.max}`);
    return x;
  }

  int(key: string, opts: { required?: boolean; min?: number; max?: number } = {}): number | null {
    const x = this.decimal(key, opts);
    if (x === null) return null;
    if (!Number.isInteger(x)) return this.error(key, `Use um número inteiro (recebido ${x})`);
    return x;
  }

  /** Hectares to whole square metres. */
  hectares(key: string, opts: { required?: boolean } = {}): number | null {
    const ha = this.decimal(key, { ...opts, min: 0 });
    return ha === null ? null : Math.round(ha * 10_000);
  }

  date(key: string, opts: { required?: boolean } = {}): { date: string; time: string | null } | null {
    const v = this.present(key, opts.required);
    if (v === null) return null;
    return parseDate(v) ?? this.error(key, `Data inválida: "${v}" (use dd/mm/aaaa)`);
  }

  time(key: string, opts: { required?: boolean } = {}): string | null {
    const v = this.present(key, opts.required);
    if (v === null) return null;
    return parseTime(v) ?? this.error(key, `Hora inválida: "${v}" (use hh:mm)`);
  }

  /** A date column plus an optional time column, as an ISO instant in São Paulo time. */
  instant(dateKey: string, timeKey: string | null, opts: { required?: boolean } = {}): string | null {
    const d = this.date(dateKey, opts);
    const t = timeKey ? this.time(timeKey) : null;
    return d ? localDateTime(d.date, t ?? d.time) : null;
  }

  /** Matches accent- and case-insensitively against the keys of `values` (pt-BR and English). */
  oneOf<T extends string>(key: string, values: Record<string, T>, opts: { required?: boolean } = {}): T | null {
    const v = this.present(key, opts.required);
    if (v === null) return null;
    const hit = values[normalizeHeader(String(v))];
    if (!hit) return this.error(key, `Valor inválido: "${v}". Use um de: ${[...new Set(Object.values(values))].join(", ")}`);
    return hit;
  }

  bool(key: string, opts: { required?: boolean } = {}): boolean | null {
    const v = this.present(key, opts.required);
    if (v === null) return null;
    const b = parseBool(v);
    return b ?? this.error(key, `Use "sim" ou "não" (recebido "${v}")`);
  }
}
