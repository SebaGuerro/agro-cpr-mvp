import { expect, test, type Page } from "@playwright/test";
import { action, br, choose, closeAll, daysFromNow, dialog, fill, fillDate, PHONE, signIn, submit } from "./helpers";

// The whole pilot story in one run, each role in its own browser:
// plot → crop cycle → CPR request → CPR issued → planting → insurer and policy →
// harvest → truck (phone) → warehouse receipt (phone) → settlement → claim → claim decision.

// The most recent season whose planting window (from 21 September in PR) has already opened.
const now = new Date();
const startYear = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
const SEASON = `${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}-SAFRA`;
const PLOT = "Talhão Sul E2E";
const PLATE = "TST1E23";

test.describe.configure({ mode: "serial" });
test.afterEach(closeAll);

let cycleUrl = "";
const cyclePage = async (page: Page) => {
  await page.goto(cycleUrl);
  await expect(page.getByRole("heading", { name: new RegExp(PLOT) })).toBeVisible();
};

test("producer registers a plot, opens a crop cycle and requests a CPR", async ({ browser }) => {
  const page = await signIn(browser, "producerPR");
  await page.goto("/produtor");
  const farm = page.locator(".mantine-Card-root").filter({ has: page.getByRole("heading", { name: "Sítio Santa Rita" }) });
  await farm.getByRole("button", { name: "Novo talhão" }).click();
  await fill(dialog(page), "Nome do talhão", PLOT);
  await fill(dialog(page), "Área (ha)", "100");
  await submit(page, "Cadastrar");

  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Novo ciclo" }) }).filter({ hasText: PLOT });
  await row.getByRole("button", { name: "Novo ciclo" }).click();
  await choose(page, dialog(page), "Safra", SEASON);
  await fill(dialog(page), "Produtividade esperada (sc/ha)", "60");
  // 100 ha × 3,600 kg/ha = 360,000 kg potential; 80% haircut → 288,000 kg eligible.
  await expect(dialog(page).getByText("288.000 kg")).toBeVisible();
  await submit(page, "Criar ciclo");

  // The new cycle shows as a badge on the plot row; it opens the cycle screen.
  await row.locator(".mantine-Badge-root").filter({ hasText: `Soja ${SEASON}` }).click();
  await expect(page.getByRole("heading", { name: new RegExp(PLOT) })).toBeVisible();
  cycleUrl = page.url();

  await action(page, "Solicitar CPR");
  await choose(page, dialog(page), "Armazém de entrega", "Armazém Central");
  await choose(page, dialog(page), "Financiador", "Securitizadora Campo");
  await fillDate(page, "Vencimento", br(daysFromNow(180)));
  await submit(page, "Enviar pedido");
  await expect(page.getByText("Pedido de CPR aguardando o financiador")).toBeVisible();
});

test("financier approves and the CPR is issued", async ({ browser }) => {
  const page = await signIn(browser, "financier");
  await cyclePage(page);
  await page.getByRole("button", { name: "Aprovar e emitir" }).click();
  await fill(dialog(page), "Número da CPR", "CPR-E2E-001");
  await fillDate(page, "Entrega a partir de", br(daysFromNow(0)));
  await fillDate(page, "Entrega até", br(daysFromNow(60)));
  await submit(page, "Emitir CPR");
  await expect(page.getByText("Emitida", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("CPR-E2E-001").first()).toBeVisible();
});

test("producer records the planting inside the window and links the insurer", async ({ browser }) => {
  const page = await signIn(browser, "producerPR");
  await cyclePage(page);
  await action(page, "Registrar plantio");
  await fill(dialog(page), "Cultivar", "Cultivar E2E 60");
  await fillDate(page, "Início do plantio", `25/09/${startYear}`);
  await fillDate(page, "Fim do plantio", `30/09/${startYear}`);
  await expect(dialog(page).getByText(/Janela de plantio/)).toBeVisible();
  await expect(dialog(page).getByText(/fora da janela/)).toHaveCount(0);
  await submit(page, "Registrar");
  await expect(page.getByText("Plantado", { exact: true }).first()).toBeVisible();

  await action(page, "Vincular seguradora");
  await choose(page, dialog(page), "Seguradora", "Seguradora Safra Segura");
  await submit(page, "Vincular");
  await expect(page.getByText(/Seguradoras vinculadas: Seguradora Safra Segura/)).toBeVisible();
});

test("insurer issues a policy", async ({ browser }) => {
  const page = await signIn(browser, "insurer");
  await cyclePage(page);
  await action(page, "Emitir apólice");
  await fill(dialog(page), "Número da apólice", "APL-E2E-1");
  await fill(dialog(page), "Importância segurada", "500000");
  await fill(dialog(page), "Prêmio", "20000");
  await fillDate(page, "Vigência de", `01/09/${startYear}`);
  await fillDate(page, "Vigência até", `30/06/${startYear + 1}`);
  await submit(page, "Emitir");
  await expect(page.getByText(/APL-E2E-1/).first()).toBeVisible();
});

test("producer starts the harvest and dispatches a truck from the phone", async ({ browser }) => {
  const desk = await signIn(browser, "producerPR");
  await cyclePage(desk);
  await action(desk, "Início da colheita");
  await submit(desk, "Registrar");
  await expect(desk.getByText("Em colheita", { exact: true }).first()).toBeVisible();

  const phone = await signIn(browser, "producerPR", PHONE);
  await phone.goto("/despacho");
  await choose(phone, phone.locator("main"), "Ciclo", new RegExp(`${PLOT}.*${SEASON.replace("/", "\\/")}`));
  await phone.getByRole("button", { name: "Novo caminhão" }).click();
  await fill(dialog(phone), "Placa", PLATE);
  await fill(dialog(phone), "Peso estimado da carga", "30000");
  await fill(dialog(phone), "Hora", "18:00");
  await submit(phone, "Despachar");
});

test("warehouse receives the truck from the phone, with the discount from the table", async ({ browser }) => {
  const page = await signIn(browser, "warehouse", PHONE);
  await page.goto("/chegadas");
  const card = page.locator(".mantine-Card-root").filter({ hasText: PLATE });
  await card.getByRole("button", { name: "Registrar chegada" }).click();
  await submit(page, "Confirmar chegada");

  await card.getByRole("button", { name: "Classificar e receber" }).click();
  await fill(dialog(page), "Número do ticket", "T-E2E-1");
  await fill(dialog(page), "Umidade (%)", "15");
  await fill(dialog(page), "Impureza (%)", "1");
  // 1 point of moisture over 14% × 1.5% = 450 kg off 30,000 kg.
  await expect(dialog(page).getByText("29.550 kg")).toBeVisible();
  await submit(page, "Registrar recebimento");
  await expect(page.locator(".mantine-Card-root").filter({ hasText: PLATE })).toHaveCount(0);
});

test("financier settles the CPR, partly in cash", async ({ browser }) => {
  const page = await signIn(browser, "financier");
  await cyclePage(page);
  await expect(page.getByText("29.550 kg").first()).toBeVisible();
  await action(page, "Liquidar CPR");
  await fill(dialog(page), "Valor liquidado em dinheiro", "1000000");
  await submit(page, "Liquidar");
  await expect(page.getByText("Encerrado", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Liquidada", { exact: true }).first()).toBeVisible();
});

test("producer reports a loss and the insurer denies it", async ({ browser }) => {
  const producer = await signIn(browser, "producerPR");
  await cyclePage(producer);
  await action(producer, "Comunicar sinistro");
  await choose(producer, dialog(producer), "Causa", "Granizo");
  await fillDate(producer, "Data da perda", br(daysFromNow(0)));
  await fill(dialog(producer), "Perda estimada", "5000");
  await fill(dialog(producer), "O que aconteceu", "Granizo na última semana da colheita.");
  await submit(producer, "Comunicar");
  await expect(producer.getByText("Aguardando a seguradora")).toBeVisible();

  const insurer = await signIn(browser, "insurer");
  await insurer.goto("/seguros");
  const claim = insurer.getByRole("row").filter({ hasText: "APL-E2E-1" });
  await claim.getByRole("button", { name: "Regular" }).click();
  await choose(insurer, dialog(insurer), "Decisão", "Recusar");
  await fill(dialog(insurer), "Motivo da recusa", "Perda abaixo da franquia");
  await submit(insurer, "Registrar");
  await expect(insurer.getByRole("row").filter({ hasText: "APL-E2E-1" }).getByRole("button", { name: "Regular" })).toHaveCount(0);
});

test("the timeline holds the whole story and reaches the chain", async ({ browser }) => {
  const page = await signIn(browser, "financier");
  await cyclePage(page);
  for (const label of ["CPR emitida", "Plantio", "Apólice emitida", "Início da colheita", "Caminhão despachado", "Caminhão chegou", "Grão recebido e classificado", "CPR liquidada", "Sinistro comunicado", "Sinistro regulado"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // The anchoring worker runs right after each write (mock chain in tests).
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Na blockchain").first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
});
