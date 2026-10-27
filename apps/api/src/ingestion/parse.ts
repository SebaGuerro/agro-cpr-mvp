import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { fail } from "../domain/errors.js";

/** A cell after reading: Excel numbers stay numbers, everything else becomes text. */
export type Cell = string | number | null;

export interface Sheet {
  format: "CSV" | "XLSX";
  headers: string[];
  /** n is the row number the user sees in Excel (header = 1 for a plain file). */
  rows: { n: number; cells: Cell[] }[];
}

export const MAX_ROWS = 2_000;
export const DATA_SHEET = "Dados";

/** "Área (ha)" → "area_ha", so headers match whatever accents and spacing were typed. */
export function normalizeHeader(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function readSheet(data: Buffer): Promise<Sheet> {
  if (data.length >= 4 && data.readUInt32BE(0) === 0x504b0304) return readXlsx(data);
  if (data.length >= 4 && data.readUInt32BE(0) === 0xd0cf11e0) {
    fail("VALIDATION_FAILED", "Arquivo .xls antigo: salve como .xlsx ou .csv");
  }
  return readCsv(data);
}

// ---------- CSV ----------

/** UTF-8 when it decodes cleanly; otherwise Windows-1252, which is what Excel in pt-BR saves as "CSV". */
export function decodeText(data: Buffer): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return data.subarray(3).toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** Excel in pt-BR writes ";" because "," is the decimal separator. Pick whichever the header uses most. */
export function detectDelimiter(firstLine: string): string {
  const outsideQuotes = firstLine.replace(/"[^"]*"/g, "");
  const counts = [";", ",", "\t"].map((d) => [d, outsideQuotes.split(d).length - 1] as const);
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ";";
}

function readCsv(data: Buffer): Sheet {
  const text = decodeText(data);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let records: string[][];
  try {
    records = parseCsv(text, {
      delimiter: detectDelimiter(firstLine),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      trim: true,
    });
  } catch (err) {
    fail("VALIDATION_FAILED", `CSV inválido: ${(err as Error).message}`);
  }
  return toSheet("CSV", records.map((cells, i) => ({ n: i + 1, cells: cells.map((c) => (c === "" ? null : c)) })));
}

// ---------- XLSX ----------

async function readXlsx(data: Buffer): Promise<Sheet> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    fail("VALIDATION_FAILED", "Não foi possível ler o arquivo .xlsx");
  }
  const ws = wb.getWorksheet(DATA_SHEET) ?? wb.worksheets[0];
  if (!ws) fail("VALIDATION_FAILED", "A planilha está vazia");
  const rows: { n: number; cells: Cell[] }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const cells: Cell[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = excelCell(cell.value);
    });
    rows.push({ n, cells: Array.from(cells, (c) => c ?? null) });
  });
  return toSheet("XLSX", rows);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Dates come back as UTC instants holding the local wall-clock time; time-only cells sit on 1899-12-30. */
export function excelCell(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (v instanceof Date) {
    const time = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
    if (v.getUTCFullYear() <= 1900) return time;
    const date = `${pad(v.getUTCDate())}/${pad(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}`;
    return time === "00:00" ? date : `${date} ${time}`;
  }
  if (typeof v === "object") {
    if ("richText" in v) return excelCell(v.richText.map((r) => r.text).join(""));
    if ("result" in v) return excelCell((v.result ?? null) as ExcelJS.CellValue);
    if ("text" in v) return excelCell(v.text as string);
    if ("error" in v) return null;
  }
  return String(v);
}

function toSheet(format: Sheet["format"], all: { n: number; cells: Cell[] }[]): Sheet {
  const nonEmpty = all.filter((r) => r.cells.some((c) => c !== null));
  const [header, ...rows] = nonEmpty;
  if (!header) fail("VALIDATION_FAILED", "A planilha está vazia");
  if (rows.length > MAX_ROWS) {
    fail("VALIDATION_FAILED", `O arquivo tem ${rows.length} linhas; o limite é ${MAX_ROWS}. Divida em arquivos menores.`);
  }
  return { format, headers: header.cells.map((c) => (c === null ? "" : String(c))), rows };
}

// ---------- values ----------

/**
 * pt-BR numbers: "1.234,56", "1234,56", "12,5", "37.000" (thousands) and plain "12.5".
 * A single dot followed by exactly three digits is read as a thousands separator.
 */
export function parseNumber(v: Cell): number | null {
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = v.replace(/\s|R\$|%/g, "");
  if (s === "") return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (hasComma) {
    if (s.split(",").length > 2) return null;
    s = s.replace(",", ".");
  } else if (hasDot && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function isRealDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** dd/mm/yyyy (optionally followed by a time) or yyyy-mm-dd, to YYYY-MM-DD. */
export function parseDate(v: Cell): { date: string; time: string | null } | null {
  if (v === null || typeof v === "number") return null;
  const s = v.trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]+(\d{1,2}[:h]\d{2}(?::\d{2})?))?$/.exec(s);
  let y: number, mo: number, d: number, t: string | undefined;
  if (m) {
    [d, mo, y, t] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  } else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{1,2}:\d{2}(?::\d{2})?))?$/.exec(s);
    if (!m) return null;
    [y, mo, d, t] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  }
  if (!isRealDate(y, mo, d)) return null;
  const time = t ? parseTime(t) : null;
  if (t && !time) return null;
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time };
}

/** "14:30", "7:05", "14h30" or an Excel fraction of a day, to HH:MM. */
export function parseTime(v: Cell): string | null {
  if (v === null) return null;
  if (typeof v === "number") {
    if (v < 0 || v >= 1) return null;
    const minutes = Math.round(v * 24 * 60);
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }
  const m = /^(\d{1,2})[:h](\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** Local São Paulo wall-clock time to an ISO instant with offset. */
export function localDateTime(date: string, time: string | null): string {
  return `${date}T${time ?? "00:00"}:00-03:00`;
}

export function cellText(v: Cell): string | null {
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

const YES = new Set(["sim", "s", "yes", "y", "true", "1", "x"]);
const NO = new Set(["nao", "n", "no", "false", "0"]);

export function parseBool(v: Cell): boolean | null {
  const s = cellText(v);
  if (s === null) return null;
  const k = normalizeHeader(s);
  if (YES.has(k)) return true;
  if (NO.has(k)) return false;
  return null;
}
