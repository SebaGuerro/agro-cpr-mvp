import type { Role } from "@agro-cpr/spec";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cropCycles, plots, type IMPORT_KINDS } from "../db/schema.js";
import type { Delivery } from "../domain/cycleState.js";
import { expectedDiscountKg } from "../domain/quantities.js";
import type { Actor, Crop } from "../domain/types.js";
import { DiscountTablesInput, PlantingWindowsInput, type Configs } from "../services/configs.js";
import { normalizeHeader, parseDate } from "./parse.js";
import { findCycle, findEvidence, findFarm, findPlot, type RefData } from "./reference.js";
import { importId, type Column, type RowReader } from "./source.js";

export type ImportKind = (typeof IMPORT_KINDS)[number];

export interface KindContext {
  tx: Db;
  actor: Actor;
  now: Date;
  ref: RefData;
  configs: Configs;
}

/** A row that already exists exactly as in the file. */
export const UNCHANGED = Symbol("unchanged");

interface KindBase {
  kind: ImportKind;
  title: string;
  description: string;
  roles: readonly Role[];
  columns: Column[];
}

export interface EventKind extends KindBase {
  mode: "events";
  /** Canonical events for the row, in order (validated afterwards like any other event). Null when the row has errors. */
  map(r: RowReader, ctx: KindContext): Promise<unknown[] | typeof UNCHANGED | null>;
}

export interface ConfigKind extends KindBase {
  mode: "config";
  map(r: RowReader): Record<string, unknown> | null;
  /** Natural key; two rows with the same key are an error. */
  keyOf(row: Record<string, unknown>): string;
}

export type KindSpec = EventKind | ConfigKind;

// ---------- shared value maps (normalized pt-BR and English → canonical) ----------

const CROP: Record<string, Crop> = { soja: "SOJA", milho: "MILHO", trigo: "TRIGO", sorgo: "SORGO", feijao: "FEIJAO" };
const CROP_OPTIONS = ["SOJA", "MILHO", "TRIGO", "SORGO", "FEIJAO"] as const;
const SEASON_KIND = { safra: "SAFRA", safrinha: "SAFRINHA", unica: "UNICA" } as const;
const CATEGORY = {
  semente: "SEED", tratamento_de_sementes: "SEED", seed: "SEED",
  fertilizante: "FERTILIZER", adubo: "FERTILIZER", fertilizer: "FERTILIZER",
  herbicida: "HERBICIDE", herbicide: "HERBICIDE",
  inseticida: "INSECTICIDE", insecticide: "INSECTICIDE",
  fungicida: "FUNGICIDE", fungicide: "FUNGICIDE",
  outro: "OTHER", outros: "OTHER", other: "OTHER",
} as const;
const CATEGORY_LABEL: Record<string, string> = {
  SEED: "SEMENTE", FERTILIZER: "FERTILIZANTE", HERBICIDE: "HERBICIDA", INSECTICIDE: "INSETICIDA", FUNGICIDE: "FUNGICIDA", OTHER: "OUTRO",
};
const UNIT = { kg: "KG", l: "L", litro: "L", litros: "L", ml: "ML" } as const;

const col = (key: string, header: string, required: boolean, format: string, example: string, help: string, extra: Partial<Column> = {}): Column => ({
  key, header, required, format, example, help, ...extra,
});
const plotCol = col("talhao", "Talhão", true, "Fazenda / Talhão, nome ou id", "Fazenda Boa Vista / Talhão 1", "Como aparece na aba Referência", { ref: "plots" });
const seasonCol = col("safra", "Safra", true, "aaaa/aa-SAFRA|SAFRINHA|UNICA", "2026/27-SAFRA", "O ciclo precisa existir no app", { ref: "seasons" });

function base(ctx: KindContext, subjectType: "PLOT" | "CROP_CYCLE", subjectId: string, id: string, occurredAt: string) {
  return { id, subjectType, subjectId, actorRole: ctx.actor.role, actorOrgId: ctx.actor.orgId, occurredAt, evidenceHash: null, refEventId: null };
}

/** Plot + season → the crop cycle, with the row's errors recorded on the right columns. */
function cycleOf(r: RowReader, ctx: KindContext) {
  const plotValue = r.text("talhao");
  const season = r.text("safra");
  if (!plotValue || !season) return null;
  const plot = findPlot(ctx.ref, plotValue);
  if (!plot.ok) return r.error("talhao", plot.message);
  const cycle = findCycle(ctx.ref, plot.value.id, season);
  if (!cycle.ok) return r.error("safra", cycle.message);
  return { plot: plot.value, cycle: cycle.value };
}

// ---------- PLOTS ----------

const PLOTS: EventKind = {
  kind: "PLOTS",
  mode: "events",
  title: "Talhões",
  description: "Um talhão por linha. Fazendas são cadastradas no app; o talhão fica ligado ao produtor da fazenda.",
  roles: ["PRODUCER", "ADMIN"],
  columns: [
    col("fazenda", "Fazenda", true, "nome ou id", "Fazenda Boa Vista", "Como aparece na aba Referência", { ref: "farms" }),
    col("talhao", "Talhão", true, "texto, até 80", "Talhão 3", "Nome único dentro da fazenda"),
    col("area_ha", "Área (ha)", true, "número, vírgula decimal", "250,5", "Área do talhão em hectares"),
    col("codigo_car", "Código CAR", false, "texto", "MT-5107925-ABCD1234", "Recibo do CAR. Um CAR de outro produtor é recusado (dupla garantia)"),
    col("municipio_ibge", "Município (IBGE)", false, "7 dígitos", "5107925", "Padrão: o município da fazenda"),
    col("uf", "UF", false, "2 letras", "MT", "Padrão: a UF da fazenda; precisa ser igual"),
    col("ref_gemeo_digital", "Ref. gêmeo digital", false, "texto, até 120", "twin:talhao-3", "Id do talhão no gêmeo digital (análise de solo)"),
  ],
  async map(r, ctx) {
    const farmValue = r.text("fazenda");
    const name = r.text("talhao", { max: 80 });
    const areaM2 = r.hectares("area_ha");
    const carCode = r.text("codigo_car", { max: 60 });
    const ibge = r.text("municipio_ibge");
    const uf = r.text("uf")?.toUpperCase() ?? null;
    const twin = r.text("ref_gemeo_digital", { max: 120 });
    if (ibge && !/^\d{7}$/.test(ibge)) r.error("municipio_ibge", "Use o código IBGE de 7 dígitos");
    if (areaM2 === 0) r.error("area_ha", "A área precisa ser maior que zero");
    const farm = farmValue ? findFarm(ctx.ref, farmValue) : null;
    if (farm && !farm.ok) r.error("fazenda", farm.message);
    if (!r.ok || !farm?.ok || !name || areaM2 === null) return null;

    const plotId = importId("plot", farm.value.id, normalizeHeader(name));
    const payload = {
      farmId: farm.value.id,
      name,
      carCode,
      municipalityIbge: ibge ?? farm.value.municipalityIbge,
      uf: uf ?? farm.value.uf,
      geometry: null,
      digitalTwinRef: twin,
    };
    const sameName = (await ctx.tx.select().from(plots).where(eq(plots.farmId, farm.value.id))).find(
      (p) => normalizeHeader(p.name) === normalizeHeader(name),
    );
    if (sameName && sameName.id !== plotId) return r.error("talhao", "Já existe um talhão com esse nome nesta fazenda");
    if (sameName) {
      const same =
        sameName.areaM2 === areaM2 &&
        sameName.carCode === payload.carCode &&
        sameName.municipalityIbge === payload.municipalityIbge &&
        sameName.uf === payload.uf &&
        sameName.digitalTwinRef === payload.digitalTwinRef;
      return same ? UNCHANGED : r.error("talhao", "Talhão já importado com outros valores. Corrija pelo app (correção de evento).");
    }
    return [{ ...base(ctx, "PLOT", plotId, importId("PLOT_REGISTERED", plotId), ctx.now.toISOString()), eventType: "PLOT_REGISTERED", quantity: areaM2, unit: "M2", payload }];
  },
};

// ---------- PLANTINGS ----------

const PLANTINGS: EventKind = {
  kind: "PLANTINGS",
  mode: "events",
  title: "Plantios",
  description: "Um plantio por ciclo (talhão + safra). A janela de plantio é conferida pela data de início.",
  roles: ["PRODUCER", "ADMIN"],
  columns: [
    plotCol,
    seasonCol,
    col("cultura", "Cultura", false, "SOJA, MILHO, ...", "SOJA", "Se preenchida, precisa ser a do ciclo", { options: CROP_OPTIONS }),
    col("cultivar", "Cultivar", true, "texto, até 80", "Cultivar exemplo 75", ""),
    col("ciclo_dias", "Ciclo (dias)", true, "inteiro 30–240", "120", "Ciclo da cultivar"),
    col("inicio_plantio", "Início do plantio", true, "dd/mm/aaaa", "20/09/2026", ""),
    col("fim_plantio", "Fim do plantio", true, "dd/mm/aaaa", "28/09/2026", ""),
    col("area_plantada_ha", "Área plantada (ha)", false, "número", "498,0", "Padrão: a área do talhão"),
  ],
  async map(r, ctx) {
    const found = cycleOf(r, ctx);
    const crop = r.oneOf("cultura", CROP);
    const cultivar = r.text("cultivar", { max: 80 });
    const cycleDays = r.int("ciclo_dias", { min: 30, max: 240 });
    const start = r.date("inicio_plantio");
    const end = r.date("fim_plantio");
    const area = r.hectares("area_plantada_ha");
    if (found && crop && crop !== found.cycle.crop) r.error("cultura", `O ciclo é de ${found.cycle.crop}`);
    if (!r.ok || !found || !cultivar || cycleDays === null || !start || !end) return null;
    const { cycle, plot } = found;
    return [
      {
        ...base(ctx, "CROP_CYCLE", cycle.id, importId("PLANTING_RECORDED", cycle.id), `${end.date}T00:00:00-03:00`),
        eventType: "PLANTING_RECORDED",
        quantity: area ?? plot.areaM2,
        unit: "M2",
        payload: { crop: cycle.crop, cultivar, cycleDays, startedOn: start.date, finishedOn: end.date },
      },
    ];
  },
};

// ---------- INPUT_APPLICATIONS ----------

const INPUT_APPLICATIONS: EventKind = {
  kind: "INPUT_APPLICATIONS",
  mode: "events",
  title: "Aplicações de insumos",
  description: "Uma aplicação por linha. Envie as notas/receitas antes (POST /v1/files) e cite o nome do arquivo na coluna Evidência.",
  roles: ["PRODUCER", "ADMIN"],
  columns: [
    plotCol,
    seasonCol,
    col("data_aplicacao", "Data da aplicação", true, "dd/mm/aaaa", "05/10/2026", ""),
    col("categoria", "Categoria", true, "SEMENTE, FERTILIZANTE, HERBICIDA, INSETICIDA, FUNGICIDA, OUTRO", "HERBICIDA", "", { options: Object.values(CATEGORY_LABEL) }),
    col("produto", "Produto", true, "texto, até 120", "Herbicida (exemplo)", "Nome comercial"),
    col("ingrediente_ativo", "Ingrediente ativo", false, "texto, até 120", "Glifosato", ""),
    col("quantidade", "Quantidade", true, "número", "1.200", "Total aplicado no talhão"),
    col("unidade", "Unidade", true, "KG, L ou ML", "L", "Litros viram mL", { options: ["KG", "L", "ML"] }),
    col("area_aplicada_ha", "Área aplicada (ha)", false, "número", "498", "Padrão: a área do talhão"),
    col("item_checklist", "Item do checklist", false, "descrição ou id", "Herbicida pré-emergente / dessecação", "Em branco: usa o único item da categoria, se houver só um", { ref: "checklist" }),
    col("chave_nfe", "Chave NF-e", false, "44 dígitos", "", ""),
    col("receituario", "Receituário agronômico", false, "texto, até 60", "RA-2026-0042", ""),
    col("evidencia", "Evidência", true, "nome do arquivo enviado ou hash SHA-256", "nf-herbicida.pdf", "Nota fiscal, receita ou foto", { ref: "evidence" }),
  ],
  async map(r, ctx) {
    const found = cycleOf(r, ctx);
    const on = r.date("data_aplicacao");
    const category = r.oneOf("categoria", CATEGORY);
    const product = r.text("produto", { max: 120 });
    const active = r.text("ingrediente_ativo", { max: 120 });
    const amount = r.decimal("quantidade", { min: 0 });
    const unit = r.oneOf("unidade", UNIT);
    const area = r.hectares("area_aplicada_ha");
    const itemValue = r.text("item_checklist");
    const nfe = r.text("chave_nfe")?.replace(/\D/g, "") ?? null;
    const recipe = r.text("receituario", { max: 60 });
    const evidenceValue = r.text("evidencia");
    if (nfe !== null && nfe.length !== 44) r.error("chave_nfe", "A chave da NF-e tem 44 dígitos");

    let quantity: number | null = null;
    if (amount !== null && unit) {
      quantity = unit === "L" ? Math.round(amount * 1000) : amount;
      if (!Number.isInteger(quantity)) r.error("quantidade", unit === "KG" ? "Em KG use um número inteiro" : "Em ML use um número inteiro");
    }
    const evidence = evidenceValue ? findEvidence(ctx.ref, evidenceValue) : null;
    if (evidence && !evidence.ok) r.error("evidencia", evidence.message);

    let checklistItemId: string | null = null;
    if (found && category) {
      const items = ctx.ref.checklist.filter((i) => i.crop === found.cycle.crop);
      if (itemValue) {
        const hit = items.find((i) => i.id === itemValue.toLowerCase() || normalizeHeader(i.description) === normalizeHeader(itemValue));
        if (!hit) r.error("item_checklist", `Item não encontrado no checklist de ${found.cycle.crop}`);
        else if (hit.category !== category) r.error("item_checklist", `O item é da categoria ${CATEGORY_LABEL[hit.category]}`);
        else checklistItemId = hit.id;
      } else {
        const sameCategory = items.filter((i) => i.category === category);
        if (sameCategory.length === 1) checklistItemId = sameCategory[0]!.id;
        else if (sameCategory.length > 1) r.error("item_checklist", `Há ${sameCategory.length} itens de ${CATEGORY_LABEL[category]} no checklist: escolha um`);
      }
    }
    if (!r.ok || !found || !on || !category || !product || quantity === null || !unit || !evidence?.ok) return null;

    const { cycle, plot } = found;
    return [
      {
        ...base(ctx, "CROP_CYCLE", cycle.id, importId("INPUT_APPLICATION_RECORDED", cycle.id, on.date, category, normalizeHeader(product)), `${on.date}T00:00:00-03:00`),
        eventType: "INPUT_APPLICATION_RECORDED",
        quantity,
        unit: unit === "L" ? "ML" : unit,
        evidenceHash: evidence.value,
        payload: {
          checklistItemId,
          category,
          productName: product,
          activeIngredient: active,
          appliedAreaM2: area ?? plot.areaM2,
          appliedOn: on.date,
          nfeKey: nfe,
          agronomistRecipeNumber: recipe,
        },
      },
    ];
  },
};

// ---------- DELIVERIES ----------

const normalizePlate = (s: string) => s.toUpperCase().replace(/[\s-]/g, "");

const DELIVERIES: EventKind = {
  kind: "DELIVERIES",
  mode: "events",
  title: "Entregas (caminhões)",
  description:
    "Um caminhão por linha, com as etapas que você tiver: saída (produtor), chegada e classificação (armazém). " +
    "Sem a saída, o caminhão é localizado pela placa entre os que estão a caminho.",
  roles: ["PRODUCER", "WAREHOUSE", "ADMIN"],
  columns: [
    plotCol,
    seasonCol,
    col("placa", "Placa", true, "ABC1D23 ou ABC1234", "ABC1D23", ""),
    col("data_saida", "Data de saída", false, "dd/mm/aaaa", "03/02/2027", "Etapa saída (produtor)"),
    col("hora_saida", "Hora de saída", false, "hh:mm", "07:00", ""),
    col("peso_estimado_kg", "Peso estimado (kg)", false, "inteiro", "37.000", "Padrão: o peso bruto, se informado"),
    col("previsao_chegada", "Previsão de chegada", false, "dd/mm/aaaa hh:mm", "03/02/2027 13:00", "Padrão: a chegada, se informada"),
    col("data_chegada", "Data de chegada", false, "dd/mm/aaaa", "03/02/2027", "Etapa chegada (armazém)"),
    col("hora_chegada", "Hora de chegada", false, "hh:mm", "12:40", ""),
    col("ticket", "Ticket", false, "texto, até 40", "T-2001", "Etapa classificação (armazém)"),
    col("peso_bruto_kg", "Peso bruto (kg)", false, "inteiro", "37.000", ""),
    col("umidade_pct", "Umidade (%)", false, "número", "15,0", ""),
    col("impureza_pct", "Impureza (%)", false, "número", "1,0", ""),
    col("avariados_pct", "Avariados (%)", false, "número", "2,0", "Padrão: 0"),
    col("desconto_kg", "Desconto (kg)", false, "inteiro", "555", "Em branco: calculado pela tabela de descontos"),
    col("peso_liquido_kg", "Peso líquido (kg)", false, "inteiro", "36.445", "Se informado, precisa ser bruto − desconto"),
  ],
  async map(r, ctx) {
    const found = cycleOf(r, ctx);
    const plateText = r.text("placa");
    const plate = plateText ? normalizePlate(plateText) : null;
    if (plate && !/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(plate)) r.error("placa", `Placa inválida: "${plateText}"`);

    const hasDispatch = r.has("data_saida");
    const hasArrival = r.has("data_chegada");
    const hasReceipt = r.has("ticket") || r.has("peso_bruto_kg");
    if (!hasDispatch && !hasArrival && !hasReceipt) r.error(undefined, "Preencha ao menos uma etapa: saída, chegada ou classificação");

    const departAt = hasDispatch ? r.instant("data_saida", "hora_saida", { required: true }) : null;
    const arriveAt = hasArrival ? r.instant("data_chegada", "hora_chegada", { required: true }) : null;
    const forecast = r.has("previsao_chegada") ? parseDate(r.raw("previsao_chegada")) : null;
    if (r.has("previsao_chegada") && !forecast) r.error("previsao_chegada", "Use dd/mm/aaaa hh:mm");

    let receipt: null | { ticket: string; gross: number; moisture: number; impurity: number; damaged: number; discount: number | null; net: number | null } = null;
    if (hasReceipt) {
      const ticket = r.text("ticket", { required: true, max: 40 });
      const gross = r.int("peso_bruto_kg", { required: true, min: 1 });
      const moisture = r.decimal("umidade_pct", { required: true, min: 0, max: 100 });
      const impurity = r.decimal("impureza_pct", { required: true, min: 0, max: 100 });
      const damaged = r.decimal("avariados_pct", { min: 0, max: 100 }) ?? 0;
      const discount = r.int("desconto_kg", { min: 0 });
      const net = r.int("peso_liquido_kg", { min: 0 });
      if (ticket && gross !== null && moisture !== null && impurity !== null) receipt = { ticket, gross, moisture, impurity, damaged, discount, net };
    }
    const estimated = r.int("peso_estimado_kg", { min: 1 }) ?? receipt?.gross ?? null;
    if (hasDispatch && estimated === null) r.error("peso_estimado_kg", "Informe o peso estimado ou o peso bruto");
    if (!r.ok || !found || !plate) return null;

    const { cycle } = found;
    const [row] = await ctx.tx.select({ state: cropCycles.state }).from(cropCycles).where(eq(cropCycles.id, cycle.id));
    const state = row!.state;
    const events: unknown[] = [];
    const ev = (eventType: string, id: string, occurredAt: string, rest: Record<string, unknown>) =>
      events.push({ ...base(ctx, "CROP_CYCLE", cycle.id, id, occurredAt), eventType, ...rest });

    // Which delivery this row is about, and which of its stages are already recorded.
    let delivery: Delivery | null = null;
    let deliveryId: string;
    if (departAt) {
      deliveryId = importId("delivery", cycle.id, plate, departAt);
      delivery = state.deliveries.find((d) => d.deliveryId === deliveryId) ?? null;
      if (delivery && delivery.estimatedKg !== estimated) return r.error("peso_estimado_kg", `Saída já importada com ${delivery.estimatedKg} kg`);
      if (!delivery) {
        const warehouseOrgId = state.cpr?.warehouseOrgId;
        if (!warehouseOrgId) return r.error("safra", "Ciclo sem CPR: caminhões só saem contra uma CPR emitida");
        const expected = forecast ? `${forecast.date}T${forecast.time ?? "00:00"}:00-03:00` : arriveAt;
        if (!expected) return r.error("previsao_chegada", "Informe a previsão de chegada ou a chegada");
        ev("TRUCK_DISPATCHED", importId("TRUCK_DISPATCHED", deliveryId), departAt, {
          quantity: estimated,
          unit: "KG",
          payload: { deliveryId, truckPlate: plate, warehouseOrgId, expectedArrivalAt: expected },
        });
      }
    } else {
      const byPlate = state.deliveries.filter((d) => d.truckPlate === plate);
      const already = byPlate.find((d) =>
        arriveAt ? d.arrivedAt !== null && Date.parse(d.arrivedAt) === Date.parse(arriveAt) : d.received?.ticketNumber === receipt?.ticket,
      );
      const open = byPlate.filter((d) => (arriveAt ? d.arrivedAt === null : d.arrivedAt !== null && d.received === null));
      if (!already && open.length !== 1) {
        return r.error(
          "placa",
          open.length === 0
            ? `Nenhum caminhão ${plate} ${arriveAt ? "a caminho" : "aguardando classificação"} neste ciclo`
            : `${open.length} caminhões ${plate} em aberto: informe a data de saída`,
        );
      }
      delivery = already ?? open[0]!;
      deliveryId = delivery.deliveryId;
    }

    let arrivedAt = delivery?.arrivedAt ?? null;
    if (arriveAt) {
      if (arrivedAt && Date.parse(arrivedAt) !== Date.parse(arriveAt)) return r.error("data_chegada", `Chegada já registrada em ${arrivedAt}`);
      if (!arrivedAt) {
        ev("TRUCK_ARRIVED", importId("TRUCK_ARRIVED", deliveryId), arriveAt, { quantity: null, unit: null, payload: { deliveryId, truckPlate: plate } });
        arrivedAt = arriveAt;
      }
    }

    if (receipt) {
      if (!arrivedAt) return r.error("data_chegada", "Informe a chegada antes da classificação");
      let discount = receipt.discount;
      if (discount === null) {
        const table = ctx.configs.discountTables.find((t) => t.crop === cycle.crop);
        if (!table) return r.error("desconto_kg", `Sem tabela de descontos para ${cycle.crop}: informe o desconto`);
        discount = expectedDiscountKg(receipt.gross, { moisturePct: receipt.moisture, impurityPct: receipt.impurity, damagedPct: receipt.damaged }, table);
      }
      const net = receipt.gross - discount;
      if (receipt.net !== null && receipt.net !== net) return r.error("peso_liquido_kg", `Bruto − desconto = ${net} kg, mas a linha diz ${receipt.net} kg`);
      if (net < 0) return r.error("desconto_kg", "O desconto é maior que o peso bruto");
      const prior = delivery?.received;
      if (prior) {
        if (prior.ticketNumber !== receipt.ticket || prior.netKg !== net) return r.error("ticket", `Caminhão já classificado (ticket ${prior.ticketNumber}, ${prior.netKg} kg)`);
      } else {
        ev("GRAIN_RECEIVED", importId("GRAIN_RECEIVED", deliveryId), arrivedAt, {
          quantity: net,
          unit: "KG",
          payload: {
            deliveryId,
            ticketNumber: receipt.ticket,
            grossKg: receipt.gross,
            moisturePct: receipt.moisture,
            impurityPct: receipt.impurity,
            damagedPct: receipt.damaged,
            discountKg: discount,
            netKg: net,
          },
        });
      }
    }
    return events.length ? events : UNCHANGED;
  },
};

// ---------- config tables (ADMIN) ----------

/** "16/09" or "16/09/2026" (year ignored) → "09-16". */
function monthDay(r: RowReader, key: string): string | null {
  const v = r.text(key);
  if (!v) return null;
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?$/.exec(v);
  const [d, mo] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (!m || mo < 1 || mo > 12 || d < 1 || d > 31) return r.error(key, `Use dd/mm (recebido "${v}")`);
  return `${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function validate<T>(r: RowReader, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const i of parsed.error.issues) r.error(undefined, `${i.path.map(String).join(".")}: ${i.message}`);
  return null;
}

const PLANTING_WINDOWS: ConfigKind = {
  kind: "PLANTING_WINDOWS",
  mode: "config",
  title: "Janelas de plantio",
  description: "SUBSTITUI a tabela inteira pelas linhas do arquivo. Use dados oficiais do ZARC; marque Amostra = sim para dados de teste.",
  roles: ["ADMIN"],
  columns: [
    col("cultura", "Cultura", true, "SOJA, MILHO, ...", "SOJA", "", { options: CROP_OPTIONS }),
    col("tipo_safra", "Tipo de safra", true, "SAFRA, SAFRINHA ou UNICA", "SAFRA", "", { options: ["SAFRA", "SAFRINHA", "UNICA"] }),
    col("uf", "UF", true, "2 letras", "MT", ""),
    col("municipio_ibge", "Município (IBGE)", false, "7 dígitos", "", "Em branco: vale para a UF inteira"),
    col("inicio", "Início", true, "dd/mm", "16/09", ""),
    col("fim", "Fim", true, "dd/mm", "31/12", ""),
    col("fonte", "Fonte", true, "texto", "ZARC portaria nº ...", "Portaria ou documento de origem"),
    col("amostra", "Amostra", true, "sim/não", "não", "sim = dado de teste", { options: ["sim", "não"] }),
  ],
  map(r) {
    const value = {
      crop: r.oneOf("cultura", CROP),
      season: r.oneOf("tipo_safra", SEASON_KIND),
      uf: r.text("uf")?.toUpperCase() ?? null,
      municipalityIbge: r.text("municipio_ibge"),
      startMonthDay: monthDay(r, "inicio"),
      endMonthDay: monthDay(r, "fim"),
      source: r.text("fonte", { max: 200 }),
      isSample: r.bool("amostra"),
    };
    return r.ok ? validate(r, PlantingWindowsInput.element, value) : null;
  },
  keyOf: (w) => [w.crop, w.season, w.uf, w.municipalityIbge ?? "*"].join("/"),
};

const DISCOUNT_TABLES: ConfigKind = {
  kind: "DISCOUNT_TABLES",
  mode: "config",
  title: "Tabelas de desconto",
  description: "SUBSTITUI a tabela inteira: uma linha por cultura. Cada ponto acima da base desconta o % indicado do peso bruto.",
  roles: ["ADMIN"],
  columns: [
    col("cultura", "Cultura", true, "SOJA, MILHO, ...", "SOJA", "", { options: CROP_OPTIONS }),
    col("umidade_base_pct", "Umidade base (%)", true, "número", "14", ""),
    col("desconto_umidade_por_ponto_pct", "Desconto por ponto de umidade (%)", true, "número", "1,5", ""),
    col("impureza_base_pct", "Impureza base (%)", true, "número", "1", ""),
    col("desconto_impureza_por_ponto_pct", "Desconto por ponto de impureza (%)", true, "número", "1", ""),
    col("avariados_base_pct", "Avariados base (%)", false, "número", "8", "Em branco: avariados não descontam"),
    col("desconto_avariados_por_ponto_pct", "Desconto por ponto de avariados (%)", false, "número", "1", ""),
    col("amostra", "Amostra", true, "sim/não", "não", "sim = dado de teste", { options: ["sim", "não"] }),
  ],
  map(r) {
    const pct = (key: string, required = true) => r.decimal(key, { required, min: 0, max: 100 });
    const value = {
      crop: r.oneOf("cultura", CROP),
      moistureBasePct: pct("umidade_base_pct"),
      moistureDiscountPerPointPct: pct("desconto_umidade_por_ponto_pct"),
      impurityBasePct: pct("impureza_base_pct"),
      impurityDiscountPerPointPct: pct("desconto_impureza_por_ponto_pct"),
      damagedBasePct: pct("avariados_base_pct", false),
      damagedDiscountPerPointPct: pct("desconto_avariados_por_ponto_pct", false),
      isSample: r.bool("amostra"),
    };
    if ((value.damagedBasePct === null) !== (value.damagedDiscountPerPointPct === null)) {
      r.error("avariados_base_pct", "Preencha a base e o desconto de avariados, ou nenhum dos dois");
    }
    return r.ok ? validate(r, DiscountTablesInput.element, value) : null;
  },
  keyOf: (t) => String(t.crop),
};

export const KINDS: Record<ImportKind, KindSpec> = { PLOTS, PLANTINGS, INPUT_APPLICATIONS, DELIVERIES, PLANTING_WINDOWS, DISCOUNT_TABLES };
