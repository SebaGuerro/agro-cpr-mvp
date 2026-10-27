import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { devVerifier } from "../src/auth.js";
import { LedgerKeys } from "../src/chain/ledger.js";
import { createMockChain } from "../src/chain/mock.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { events, plots } from "../src/db/schema.js";
import { anchorPending } from "../src/jobs/anchor.js";
import { SEED, seedScenario, type SeedResult } from "../src/seed/scenario.js";
import { memoryStorage } from "../src/storage.js";

const NOW = new Date("2026-10-27T15:00:00Z");
const keys = new LedgerKeys("test-secret-test-secret-test-secret-00");

let handle: DbHandle;
let app: FastifyInstance;
let seed: SeedResult;

type Who = keyof typeof SEED.users;
const auth = (who: Who) => ({ authorization: `Bearer dev:${SEED.users[who]}` });

async function call(who: Who, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: auth(who), payload: payload as object | undefined });
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? (res.json() as any) : res.rawPayload };
}

function multipart(fields: Record<string, string>, file: { name: string; data: Buffer; type: string }) {
  const b = "----agroimport";
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}

async function upload(who: Who, kind: string, file: Buffer, opts: { dryRun?: boolean; name?: string } = {}) {
  const isXlsx = file.readUInt32BE(0) === 0x504b0304;
  const name = opts.name ?? (isXlsx ? "dados.xlsx" : "dados.csv");
  const type = isXlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv";
  const form = multipart({ kind, dryRun: String(opts.dryRun ?? false) }, { name, data: file, type });
  const res = await app.inject({ method: "POST", url: "/v1/imports", headers: { ...auth(who), ...form.headers }, payload: form.payload });
  return { status: res.statusCode, body: res.json() as any };
}

const csv = (lines: string[], encoding: BufferEncoding = "utf8") => Buffer.from(lines.join("\r\n"), encoding);

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Dados");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function readXlsx(data: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  return wb;
}

const fulfilled = async () => (await call("financier", "GET", `/v1/crop-cycles/${seed.shortfallCycleId}`)).body.fulfillment;

beforeAll(async () => {
  handle = createDb("pglite:memory");
  await handle.migrate();
  seed = await seedScenario(handle.db, { now: NOW, toleranceBps: 200 });
  app = await buildApp({ db: handle.db, verify: devVerifier, storage: memoryStorage(), keys, now: () => NOW, toleranceBps: 200, corsOrigins: ["*"] });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

describe("templates", () => {
  it("lists only what the caller may reference, with dropdowns", async () => {
    const res = await call("producerMT", "GET", "/v1/imports/templates/input_applications");
    expect(res.status).toBe(200);
    const wb = await readXlsx(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Dados", "Instruções", "Referência"]);
    const ref = wb.getWorksheet("Referência")!;
    const plotsListed = ref.getColumn(1).values.slice(2);
    expect(plotsListed).toEqual(["Fazenda Boa Vista / Talhão 1", "Fazenda Boa Vista / Talhão 2"]);
    const dados = wb.getWorksheet("Dados")!;
    expect(dados.getCell("A1").value).toBe("Talhão *");
    expect(dados.getCell("D50").dataValidation?.type).toBe("list"); // Categoria
  });

  it("refuses kinds the role can't import", async () => {
    expect((await call("warehouse", "GET", "/v1/imports/templates/plots")).status).toBe(403);
    expect((await call("producerPR", "GET", "/v1/imports/templates/planting_windows")).status).toBe(403);
  });
});

describe("plots import", () => {
  const file = csv(
    ["Fazenda;Talhão;Área (ha);Código CAR;Ref. gêmeo digital", "Fazenda Boa Vista;Talhão 3;250,5;MT-5107925-SAMPLE-0001;twin:t3", "Fazenda Boa Vista;Talhão 4;1.200;;"],
    "latin1",
  );
  let batchId: string;

  it("validates a Windows-1252 CSV without writing anything", async () => {
    const res = await upload("producerMT", "PLOTS", file, { dryRun: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "VALIDATED", dryRun: true, totalRows: 2, acceptedRows: 2, rejectedRows: 0, errors: [] });
    expect(await handle.db.select().from(plots)).toHaveLength(3);
    batchId = res.body.id;
  });

  it("applies the dry run from the stored rows", async () => {
    const res = await call("producerMT", "POST", `/v1/imports/${batchId}/apply`);
    expect(res.body).toMatchObject({ status: "APPLIED", dryRun: false, eventCount: 2 });
    expect(res.body.rollbackAvailableUntil).toBe("2026-10-27T15:29:00.000Z");
    const rows = await handle.db.select().from(plots);
    expect(rows.find((p) => p.name === "Talhão 3")).toMatchObject({ areaM2: 2_505_000, digitalTwinRef: "twin:t3", uf: "MT", municipalityIbge: "5107925" });
    expect(rows.find((p) => p.name === "Talhão 4")?.areaM2).toBe(12_000_000);
  });

  it("is idempotent when the same file is uploaded again", async () => {
    const res = await upload("producerMT", "PLOTS", file);
    expect(res.body).toMatchObject({ status: "APPLIED", acceptedRows: 0, unchangedRows: 2, eventCount: 0 });
  });

  it("reports every bad row, writes nothing and returns an annotated file", async () => {
    const res = await upload(
      "producerMT",
      "PLOTS",
      csv(["Fazenda,Talhão,Área (ha)", "Fazenda Boa Vista,Talhão 1,10", "Sítio Santa Rita,Talhão X,5", "Fazenda Boa Vista,Talhão 9,abc", 'Fazenda Boa Vista,Talhão 10,"12,5"']),
    );
    expect(res.body).toMatchObject({ status: "FAILED", totalRows: 4, acceptedRows: 1, rejectedRows: 3, eventCount: 0 });
    expect(res.body.errors.map((e: any) => [e.row, e.column])).toEqual([
      [2, "Talhão"],
      [3, "Fazenda"],
      [4, "Área (ha)"],
    ]);
    expect((await handle.db.select().from(plots)).some((p) => p.name === "Talhão 10")).toBe(false);

    const annotated = await call("producerMT", "GET", `/v1/imports/${res.body.id}/annotated`);
    const ws = (await readXlsx(annotated.body)).getWorksheet("Dados")!;
    expect(ws.getCell("D1").value).toBe("erro");
    expect(String(ws.getCell("D2").value)).toMatch(/Já existe um talhão/);
    expect(ws.getCell("D5").value).toBeNull();
  });

  it("rejects a file without the required columns", async () => {
    const res = await upload("producerMT", "PLOTS", csv(["Fazenda;Nome", "Fazenda Boa Vista;Talhão 5"]));
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: any) => e.path)).toEqual(["talhao", "area_ha"]);
  });

  it("refuses more than 2,000 rows", async () => {
    const lines = ["Fazenda;Talhão;Área (ha)", ...Array.from({ length: 2_001 }, (_, i) => `Fazenda Boa Vista;T${i};1`)];
    const res = await upload("producerMT", "PLOTS", csv(lines));
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/limite é 2000/);
  });

  it("won't roll back plots that already have a crop cycle", async () => {
    const [plot] = await handle.db.select().from(plots).where(eq(plots.name, "Talhão 3"));
    await call("producerMT", "POST", "/v1/crop-cycles", { plotId: plot!.id, crop: "SOJA", seasonCode: "2026/27-SAFRA", expectedYieldKgPerHa: 3_600 });
    const res = await call("producerMT", "POST", `/v1/imports/${batchId}/rollback`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BATCH_HAS_DEPENDENTS");
  });
});

describe("deliveries import", () => {
  const plot = "Sítio Santa Rita / Talhão Norte";
  const header = ["Talhão", "Safra", "Placa", "Data de saída", "Hora de saída", "Data de chegada", "Hora de chegada", "Ticket", "Peso bruto (kg)", "Umidade (%)", "Impureza (%)"];
  let adminBatch: string;

  it("records dispatch, arrival and classification from one row, computing the discount", async () => {
    // Excel date cell for the dispatch, text for the arrival.
    const file = await xlsx([header, [plot, "2025/26 safra", "xyz-1a23", new Date(Date.UTC(2026, 9, 20)), "07:00", "20/10/2026", "12:30", "T-9001", 30_000, "15,0", 1]]);
    const res = await upload("admin", "DELIVERIES", file);
    expect(res.body).toMatchObject({ status: "APPLIED", acceptedRows: 1, eventCount: 3 });
    adminBatch = res.body.id;
    // 1 point of moisture over 14% x 1.5% = 450 kg off 30,000 kg.
    expect(await fulfilled()).toMatchObject({ deliveredNetKg: 104_562 + 29_550, trucksInTransit: 0 });
    const timeline = await call("admin", "GET", `/v1/crop-cycles/${seed.shortfallCycleId}/timeline`);
    const received = timeline.body.events.find((e: any) => e.payload?.ticketNumber === "T-9001");
    expect(received).toMatchObject({ provenance: "IMPORTED", importBatchId: adminBatch, payload: { discountKg: 450, netKg: 29_550 } });
  });

  it("rolls the batch back while it is still in the review window", async () => {
    const res = await call("admin", "POST", `/v1/imports/${adminBatch}/rollback`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ROLLED_BACK");
    expect(await fulfilled()).toMatchObject({ deliveredNetKg: 104_562, trucksInTransit: 0 });
    expect(await handle.db.select().from(events).where(eq(events.importBatchId, adminBatch))).toEqual([]);
    expect((await call("admin", "POST", `/v1/imports/${adminBatch}/rollback`)).body.code).toBe("INVALID_TRANSITION");
  });

  let producerBatch: string;
  let warehouseBatch: string;

  it("lets the producer dispatch and the warehouse receive the same truck, matched by plate", async () => {
    const dispatch = csv(["Talhão;Safra;Placa;Data de saída;Hora de saída;Peso estimado (kg);Previsão de chegada", `${plot};2025/26-SAFRA;BRA2E19;21/10/2026;08:00;32.000;21/10/2026 14:00`]);
    const sent = await upload("producerPR", "DELIVERIES", dispatch);
    expect(sent.body).toMatchObject({ status: "APPLIED", eventCount: 1 });
    producerBatch = sent.body.id;
    expect((await fulfilled()).trucksInTransit).toBe(1);

    const arrival = csv([
      "Talhão;Safra;Placa;Data de chegada;Hora de chegada;Ticket;Peso bruto (kg);Umidade (%);Impureza (%);Desconto (kg);Peso líquido (kg)",
      `${plot};2025/26-SAFRA;BRA2E19;21/10/2026;13:50;T-9002;32.000;14;1;0;32.000`,
    ]);
    const received = await upload("warehouse", "DELIVERIES", arrival);
    expect(received.body).toMatchObject({ status: "APPLIED", eventCount: 2 });
    warehouseBatch = received.body.id;
    expect(await fulfilled()).toMatchObject({ deliveredNetKg: 104_562 + 32_000, trucksInTransit: 0 });

    // Same file again: nothing new.
    expect((await upload("warehouse", "DELIVERIES", arrival)).body).toMatchObject({ status: "APPLIED", unchangedRows: 1, eventCount: 0 });
  });

  it("keeps each stage to its role and reports a truck it can't find", async () => {
    const file = csv([
      "Talhão;Safra;Placa;Data de saída;Hora de saída;Peso estimado (kg);Data de chegada;Hora de chegada",
      `${plot};2025/26-SAFRA;QWE1R23;22/10/2026;08:00;30000;22/10/2026;13:00`,
      `${plot};2025/26-SAFRA;ZZZ9Z99;;;;22/10/2026;13:00`,
    ]);
    const res = await upload("warehouse", "DELIVERIES", file, { dryRun: true });
    expect(res.body.status).toBe("FAILED");
    expect(res.body.errors[0]).toMatchObject({ row: 2, code: "FORBIDDEN_ROLE" });
    expect(res.body.errors[1]).toMatchObject({ row: 3, column: "Placa" });
    expect(res.body.errors[1].message).toMatch(/Nenhum caminhão ZZZ9Z99/);
  });

  it("won't roll back a batch that a later batch builds on", async () => {
    const res = await call("producerPR", "POST", `/v1/imports/${producerBatch}/rollback`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BATCH_HAS_DEPENDENTS");
  });

  it("holds imported events back from anchoring until the review window ends", async () => {
    const chain = createMockChain();
    const pending = async () => (await handle.db.select().from(events).where(eq(events.importBatchId, warehouseBatch))).map((e) => e.anchorStatus);
    for (let r = { anchored: 1 }; r.anchored > 0; ) r = await anchorPending(handle.db, chain, keys, { now: () => NOW, limit: 200 });
    expect(await pending()).toEqual(["PENDING", "PENDING"]);

    const later = () => new Date(NOW.getTime() + 31 * 60_000);
    for (let r = { anchored: 1 }; r.anchored > 0; ) r = await anchorPending(handle.db, chain, keys, { now: later, limit: 200 });
    expect(await pending()).toEqual(["ANCHORED", "ANCHORED"]);

    const res = await call("warehouse", "POST", `/v1/imports/${warehouseBatch}/rollback`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BATCH_ALREADY_ANCHORED");
  });
});

describe("input applications import", () => {
  it("resolves evidence by file name and the checklist item by category", async () => {
    const form = multipart({}, { name: "nf-herbicida-mt.pdf", data: Buffer.from("nota fiscal herbicida"), type: "application/pdf" });
    const uploaded = await app.inject({ method: "POST", url: "/v1/files", headers: { ...auth("producerMT"), ...form.headers }, payload: form.payload });
    expect(uploaded.json().fileName).toBe("nf-herbicida-mt.pdf");

    const header = "Talhão;Safra;Data da aplicação;Categoria;Produto;Quantidade;Unidade;Evidência";
    const good = "Talhão 1;2026/27-SAFRA;01/10/2026;Herbicida;Herbicida X;2,5;L;nf-herbicida-mt.pdf";
    const bad = await upload("producerMT", "INPUT_APPLICATIONS", csv([header, good, "Talhão 1;2026/27-SAFRA;02/10/2026;fungicida;Fungicida Y;1;L;nao-enviado.pdf"]), { dryRun: true });
    expect(bad.body.status).toBe("FAILED");
    expect(bad.body.errors).toEqual([expect.objectContaining({ row: 3, column: "Evidência" })]);

    const res = await upload("producerMT", "INPUT_APPLICATIONS", csv([header, good]));
    expect(res.body).toMatchObject({ status: "APPLIED", eventCount: 1 });
    const [ev] = await handle.db.select().from(events).where(eq(events.importBatchId, res.body.id));
    expect(ev!.body).toMatchObject({ quantity: 2_500, unit: "ML", evidenceHash: uploaded.json().sha256, payload: { checklistItemId: SEED.checklistItems.preEmergence, appliedAreaM2: 5_000_000 } });
  });
});

describe("plantings import", () => {
  it("explains a missing cycle and a cycle already planted", async () => {
    const res = await upload(
      "producerMT",
      "PLANTINGS",
      csv([
        "Talhão;Safra;Cultivar;Ciclo (dias);Início do plantio;Fim do plantio",
        "Talhão 2;2026/27-SAFRA;C1;120;20/09/2026;25/09/2026",
        "Talhão 1;2026/27-SAFRA;C1;120;20/09/2026;25/09/2026",
      ]),
      { dryRun: true },
    );
    expect(res.body.status).toBe("FAILED");
    expect(res.body.errors[0].message).toMatch(/Não há ciclo 2026\/27-SAFRA/);
    expect(res.body.errors[1].code).toBe("INVALID_TRANSITION");
  });
});

describe("planting windows import", () => {
  const header = ["Cultura", "Tipo de safra", "UF", "Início", "Fim", "Fonte", "Amostra"];
  const rows = [
    ["SOJA", "SAFRA", "MT", "16/09", "31/12", "teste", "sim"],
    ["Milho", "safrinha", "MT", "01/01", "10/03", "teste", "sim"],
  ];
  let batchId: string;

  it("refuses duplicate rows and non-admins", async () => {
    const dup = await upload("admin", "PLANTING_WINDOWS", await xlsx([header, ...rows, rows[0]!]));
    expect(dup.body.status).toBe("FAILED");
    expect(dup.body.errors[0]).toMatchObject({ row: 4 });
    expect((await upload("producerMT", "PLANTING_WINDOWS", await xlsx([header, ...rows]))).status).toBe(403);
  });

  it("replaces the table and rolls back to the previous one", async () => {
    const res = await upload("admin", "PLANTING_WINDOWS", await xlsx([header, ...rows]));
    expect(res.body).toMatchObject({ status: "APPLIED", acceptedRows: 2, rollbackAvailableUntil: null });
    batchId = res.body.id;
    expect((await call("admin", "GET", "/v1/config/planting-windows")).body).toHaveLength(2);

    expect((await call("admin", "POST", `/v1/imports/${batchId}/rollback`)).body.status).toBe("ROLLED_BACK");
    expect((await call("admin", "GET", "/v1/config/planting-windows")).body).toHaveLength(3);
  });

  it("won't roll back after the table was edited", async () => {
    const res = await upload("admin", "PLANTING_WINDOWS", await xlsx([header, ...rows]));
    const current = (await call("admin", "GET", "/v1/config/planting-windows")).body;
    await call("admin", "PUT", "/v1/config/planting-windows", [{ ...current[0], source: "editado" }, current[1]]);
    const rollback = await call("admin", "POST", `/v1/imports/${res.body.id}/rollback`);
    expect(rollback.status).toBe(409);
    expect(rollback.body.code).toBe("BATCH_HAS_DEPENDENTS");
  });
});

describe("batch visibility", () => {
  it("shows a batch to its organization only", async () => {
    const mine = await call("producerMT", "GET", "/v1/imports");
    expect(mine.body.length).toBeGreaterThan(0);
    expect(mine.body.every((b: any) => b.createdBy === SEED.users.producerMT)).toBe(true);
    expect((await call("producerPR", "GET", `/v1/imports/${mine.body[0].id}`)).status).toBe(404);
  });
});
