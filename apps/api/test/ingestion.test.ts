import { Uuid } from "@agro-cpr/spec";
import { describe, expect, it } from "vitest";
import { decodeText, detectDelimiter, normalizeHeader, parseDate, parseNumber, parseTime, readSheet } from "../src/ingestion/parse.js";
import { normalizeSeason } from "../src/ingestion/reference.js";
import { importId } from "../src/ingestion/source.js";

describe("pt-BR values", () => {
  it("reads decimal commas and thousands dots", () => {
    expect(parseNumber("1.234,56")).toBe(1234.56);
    expect(parseNumber("250,5")).toBe(250.5);
    expect(parseNumber("37.000")).toBe(37000);
    expect(parseNumber("12.5")).toBe(12.5);
    expect(parseNumber("1,234.56")).toBe(1234.56);
    expect(parseNumber("15 %")).toBe(15);
    expect(parseNumber(1.234)).toBe(1.234); // Excel numbers are already numbers
    expect(parseNumber("1,2,3")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
  });

  it("reads dd/mm/yyyy dates, ISO dates and times", () => {
    expect(parseDate("05/10/2026")).toEqual({ date: "2026-10-05", time: null });
    expect(parseDate("5/10/2026 7:05")).toEqual({ date: "2026-10-05", time: "07:05" });
    expect(parseDate("2026-10-05")).toEqual({ date: "2026-10-05", time: null });
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("10/05/26")).toBeNull();
    expect(parseTime("14h30")).toBe("14:30");
    expect(parseTime(0.5)).toBe("12:00");
    expect(parseTime("25:00")).toBeNull();
  });

  it("matches headers and seasons however they were typed", () => {
    expect(normalizeHeader("Área (ha) *")).toBe("area_ha");
    expect(normalizeHeader("Município (IBGE)")).toBe("municipio_ibge");
    expect(normalizeSeason("2026/27 safrinha")).toBe("2026/27-SAFRINHA");
    expect(normalizeSeason(" 2026/27 - Safra ")).toBe("2026/27-SAFRA");
  });
});

describe("CSV files", () => {
  it("detects the separator Excel used", () => {
    expect(detectDelimiter("Fazenda;Talhão;Área (ha)")).toBe(";");
    expect(detectDelimiter('Fazenda,"Talhão; norte",Área')).toBe(",");
  });

  it("decodes UTF-8, UTF-8 with BOM and Windows-1252", () => {
    expect(decodeText(Buffer.from("Talhão", "utf8"))).toBe("Talhão");
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Área", "utf8")]))).toBe("Área");
    expect(decodeText(Buffer.from("Talhão;Área", "latin1"))).toBe("Talhão;Área");
  });

  it("skips blank lines but keeps the row numbers the user sees", async () => {
    const sheet = await readSheet(Buffer.from("a;b\n1;2\n;\n3;4\n"));
    expect(sheet.format).toBe("CSV");
    expect(sheet.rows.map((r) => r.n)).toEqual([2, 4]);
  });

  it("refuses old .xls files", async () => {
    await expect(readSheet(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).rejects.toThrow(/xls/);
  });
});

describe("import ids", () => {
  it("are deterministic, valid UUIDs", () => {
    const a = importId("plot", "farm", "talhao_3");
    expect(a).toBe(importId("plot", "farm", "talhao_3"));
    expect(a).not.toBe(importId("plot", "farm", "talhao_4"));
    expect(Uuid.safeParse(a).success).toBe(true);
    expect(a[14]).toBe("8");
  });
});
