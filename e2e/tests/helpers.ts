import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

/** The seeded demo users (apps/api/src/seed/scenario.ts). */
const seedUser = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const USERS = {
  admin: seedUser(201),
  producerPR: seedUser(203),
  warehouse: seedUser(204),
  financier: seedUser(206),
  insurer: seedUser(207),
} as const;

export const PHONE = { width: 390, height: 844 };

const contexts: BrowserContext[] = [];

/** Closes the step's browsers; this is also when their videos are written. */
export async function closeAll() {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
}

/** A page signed in as one demo user (the dev login keeps the user id in localStorage). */
export async function signIn(browser: Browser, who: keyof typeof USERS, viewport?: { width: number; height: number }): Promise<Page> {
  // Contexts made here don't get the project's `video` setting by themselves.
  const size = viewport ?? { width: 1280, height: 720 };
  const recordVideo = test.info().project.use.video === "on" ? { recordVideo: { dir: test.info().outputPath(`video-${who}`), size } } : {};
  const context = await browser.newContext({ ...(viewport ? { viewport, isMobile: true, hasTouch: true } : {}), ...recordVideo });
  contexts.push(context);
  await context.addInitScript((id) => localStorage.setItem("agro.devUser", id), USERS[who]);
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    throw new Error(`Page error as ${who}: ${err.message}`);
  });
  return page;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** A date in São Paulo, as typed in the forms (dd/mm/aaaa). */
export function br(d: Date): string {
  const local = new Date(d.getTime() - 3 * 3600_000);
  return `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}/${local.getUTCFullYear()}`;
}
export const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

/** The open modal form. */
export const dialog = (page: Page) => page.getByRole("dialog");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The input of a Mantine field, found by its label text. Labels carry a " *" when required,
 * and date inputs aren't linked to their label, so getByLabel misses some fields.
 */
export function field(scope: Locator, label: string): Locator {
  const labelEl = scope.page().locator("label", { hasText: new RegExp(`^${escapeRe(label)}( \\*)?$`) });
  return scope.locator(".mantine-InputWrapper-root").filter({ has: labelEl }).locator("input:not([type=hidden]), textarea").first();
}

export async function fill(scope: Locator, label: string, value: string) {
  await field(scope, label).fill(value);
}

/** Mantine DateInput parses the typed date on blur; click the modal title to blur without closing. */
export async function fillDate(page: Page, label: string, value: string) {
  const form = dialog(page);
  await field(form, label).fill(value);
  await form.locator(".mantine-Modal-title").click();
  await expect(field(form, label)).toHaveValue(value);
}

/** Mantine Select: open it and click the option. */
export async function choose(page: Page, scope: Locator, label: string, option: string | RegExp) {
  await field(scope, label).click();
  await page.getByRole("option", { name: option }).first().click();
}

/** Submit the open form and wait for it to close (a failed save keeps it open with a toast). */
export async function submit(page: Page, button: string) {
  await dialog(page).getByRole("button", { name: button, exact: true }).click();
  await expect(dialog(page)).toHaveCount(0, { timeout: 15_000 });
}

export async function action(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}
