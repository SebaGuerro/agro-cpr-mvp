import ExcelJS from "exceljs";
import type { ImportRowError } from "../db/schema.js";
import type { KindSpec } from "./kinds.js";
import { DATA_SHEET, MAX_ROWS, type Sheet } from "./parse.js";
import type { RefData } from "./reference.js";
import type { Column } from "./source.js";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const REF_SHEET = "Referência";
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F5132" } };
const ERROR_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE2E1" } };

const colLetter = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.eachCell((c) => {
    c.fill = HEADER_FILL;
  });
}

/** One list per column of the reference sheet; returns the range each dropdown points to. */
function writeReference(wb: ExcelJS.Workbook, ref: RefData): Record<NonNullable<Column["ref"]>, string | null> {
  const ws = wb.addWorksheet(REF_SHEET);
  const lists: [NonNullable<Column["ref"]>, string, string[], string, string[]][] = [
    ["plots", "Talhão (use este texto)", ref.plots.map((p) => p.label), "Id do talhão", ref.plots.map((p) => p.id)],
    ["seasons", "Safras com ciclo", [...new Set(ref.cycles.map((c) => c.seasonCode))].sort(), "", []],
    ["farms", "Fazenda", ref.farms.map((f) => f.name), "Id da fazenda", ref.farms.map((f) => f.id)],
    ["checklist", "Item do checklist", ref.checklist.map((i) => i.description), "Cultura", ref.checklist.map((i) => i.crop)],
    ["evidence", "Evidência (arquivo enviado)", ref.evidence.map((e) => e.name ?? e.sha256), "Hash SHA-256", ref.evidence.map((e) => e.sha256)],
  ];
  const ranges = {} as Record<NonNullable<Column["ref"]>, string | null>;
  let col = 0;
  for (const [key, title, values, extraTitle, extra] of lists) {
    ws.getCell(1, col + 1).value = title;
    values.forEach((v, i) => (ws.getCell(i + 2, col + 1).value = v));
    ws.getColumn(col + 1).width = Math.min(60, Math.max(18, ...values.map((v) => v.length + 2)));
    ranges[key] = values.length ? `'${REF_SHEET}'!$${colLetter(col)}$2:$${colLetter(col)}$${values.length + 1}` : null;
    if (extraTitle) {
      ws.getCell(1, col + 2).value = extraTitle;
      extra.forEach((v, i) => (ws.getCell(i + 2, col + 2).value = v));
      ws.getColumn(col + 2).width = 38;
      col += 1;
    }
    col += 2; // one blank column between lists
  }
  styleHeader(ws.getRow(1));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return ranges;
}

/** The template for one kind: data sheet with dropdowns, instructions with an example row, and the caller's reference lists. */
export async function buildTemplate(spec: KindSpec, ref: RefData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "agro-cpr";
  const data = wb.addWorksheet(DATA_SHEET);
  const help = wb.addWorksheet("Instruções");
  const ranges = writeReference(wb, ref);

  data.addRow(spec.columns.map((c) => (c.required ? `${c.header} *` : c.header)));
  styleHeader(data.getRow(1));
  data.views = [{ state: "frozen", ySplit: 1 }];
  spec.columns.forEach((c, i) => {
    const column = data.getColumn(i + 1);
    column.width = Math.max(14, c.header.length + 4);
    column.numFmt = "@"; // text, so Excel doesn't reformat codes, plates and dates
    const formula = c.options ? `"${c.options.join(",")}"` : c.ref ? ranges[c.ref] : null;
    if (!formula) return;
    const letter = colLetter(i);
    // Excel accepts anything typed when the list is not strict, so ids and other spellings still work.
    (data as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } }).dataValidations.add(`${letter}2:${letter}${MAX_ROWS + 1}`, {
      type: "list",
      allowBlank: true,
      formulae: [formula],
      showErrorMessage: false,
    });
  });

  help.getColumn(1).width = 34;
  help.getColumn(2).width = 14;
  help.getColumn(3).width = 34;
  help.getColumn(4).width = 30;
  help.getColumn(5).width = 70;
  help.addRow([`Importação: ${spec.title}`]).font = { bold: true, size: 14 };
  help.addRow([spec.description]);
  help.addRow([
    `Preencha a aba "${DATA_SHEET}" a partir da linha 2 (até ${MAX_ROWS} linhas). Colunas com * são obrigatórias. ` +
      `Números com vírgula decimal (1.234,5), datas dd/mm/aaaa. Valide primeiro (simulação) e depois aplique: ` +
      `o lote entra inteiro ou não entra. Reenviar o mesmo arquivo não duplica nada.`,
  ]);
  help.addRow([]);
  styleHeader(help.addRow(["Coluna", "Obrigatória", "Formato", "Exemplo", "Observação"]));
  for (const c of spec.columns) help.addRow([c.header, c.required ? "sim" : "não", c.format, c.example, c.help]);
  help.addRow([]);
  help.addRow(["Linha de exemplo (copie para a aba Dados e ajuste):"]).font = { bold: true };
  styleHeader(help.addRow(spec.columns.map((c) => c.header)));
  help.addRow(spec.columns.map((c) => c.example));
  help.getColumn(1).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The uploaded rows with an "erro" column, rows with problems highlighted, ready to fix and upload again. */
export async function annotatedWorkbook(sheet: Pick<Sheet, "headers" | "rows">, errors: ImportRowError[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(DATA_SHEET);
  const byRow = new Map<number, string[]>();
  for (const e of errors) byRow.set(e.row, [...(byRow.get(e.row) ?? []), e.column ? `${e.column}: ${e.message}` : e.message]);

  ws.addRow([...sheet.headers, "erro"]);
  styleHeader(ws.getRow(1));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const headerErrors = byRow.get(1);
  if (headerErrors) ws.getCell(1, sheet.headers.length + 1).note = headerErrors.join("\n");
  for (const r of sheet.rows) {
    const msgs = byRow.get(r.n);
    const row = ws.addRow([...sheet.headers.map((_, i) => r.cells[i] ?? null), msgs?.join(" | ") ?? null]);
    if (msgs) row.eachCell({ includeEmpty: true }, (c) => (c.fill = ERROR_FILL));
  }
  sheet.headers.forEach((h, i) => (ws.getColumn(i + 1).width = Math.max(12, h.length + 2)));
  ws.getColumn(sheet.headers.length + 1).width = 80;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
