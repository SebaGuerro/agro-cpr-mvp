const KG_PER_SACA = 60;
const nf0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : nf0.format(n));
export const fmtKg = (kg: number | null | undefined) => (kg === null || kg === undefined ? "—" : `${nf0.format(kg)} kg`);
export const fmtTons = (kg: number | null | undefined) => (kg === null || kg === undefined ? "—" : `${nf1.format(kg / 1000)} t`);
export const fmtSacas = (kg: number | null | undefined) => (kg === null || kg === undefined ? "—" : `${nf1.format(kg / KG_PER_SACA)} sc`);
export const fmtHa = (m2: number | null | undefined) => (m2 === null || m2 === undefined ? "—" : `${nf1.format(m2 / 10_000)} ha`);
export const fmtBrl = (cents: number | null | undefined) => (cents === null || cents === undefined ? "—" : brl.format(cents / 100));
export const fmtPct = (bps: number) => `${nf1.format(bps / 100)}%`;

/** "2026-10-05" → "05/10/2026". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** An instant shown in São Paulo time (UTC−3, no daylight saving since 2019). */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const local = new Date(Date.parse(iso) - 3 * 3600_000).toISOString();
  return `${fmtDate(local)} ${local.slice(11, 16)}`;
}

/** Today's date in São Paulo, YYYY-MM-DD. */
export function todayLocal(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}

/** Now as an ISO instant with the São Paulo offset. */
export function nowLocalIso(): string {
  return `${new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 19)}-03:00`;
}

/** A local date and HH:mm as an ISO instant with the São Paulo offset. */
export function localIso(date: string, time = "12:00"): string {
  return `${date}T${time}:00-03:00`;
}

/** When a fact happened on a given day: noon, or now if that day is today (the API rejects future times). */
export function occurredOn(date: string): string {
  return date >= todayLocal() ? nowLocalIso() : localIso(date);
}
