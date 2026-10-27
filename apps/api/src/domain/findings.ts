import { checklistStatus, type ChecklistTemplate } from "./checklist.js";
import type { CycleState } from "./cycleState.js";
import { addDays, daysBetween, localDate } from "./dates.js";
import { checkPlanting, findWindow, windowDates, type PlantingWindow } from "./plantingWindow.js";
import { expectedDiscountKg, isFulfilled, isTicketMismatch, type DiscountTable } from "./quantities.js";
import type { CycleFacts } from "./types.js";

export type Dimension = "PLANTING_WINDOW" | "INPUT_COMPLIANCE" | "HARVEST_DELIVERY";
export type Severity = "INFO" | "WARNING" | "HIGH";

/** Alert types the cycle sync owns. Other types (e.g. ANCHOR_FAILED) are raised elsewhere. */
export const DERIVED_ALERT_TYPES = [
  "PLANTED_OUTSIDE_WINDOW",
  "PLANTING_WINDOW_MISSED",
  "APPLICATION_MISSING",
  "APPLICATION_LATE",
  "HARVEST_NOT_PLANNED",
  "HARVEST_OVERDUE",
  "DELIVERY_OVERDUE",
  "DELIVERY_SHORTFALL",
  "QUALITY_TICKET_MISMATCH",
  "CPR_DUE_SOON",
  "INFO_REQUEST_OPEN",
] as const;
export type DerivedAlertType = (typeof DERIVED_ALERT_TYPES)[number];

export interface Finding {
  code: string;
  message: string;
  eventId: string | null;
  /** Risk contribution; null when the finding is informational only. */
  risk: null | { dimension: Dimension; points: number };
  alert: null | { type: DerivedAlertType; severity: Severity; key: string };
}

export interface FindingInputs {
  cycle: CycleFacts;
  plot: { uf: string; municipalityIbge: string };
  state: CycleState;
  windows: PlantingWindow[];
  templates: ChecklistTemplate[];
  discountTables: DiscountTable[];
  toleranceBps: number;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function cycleFindings(i: FindingInputs): Finding[] {
  const { cycle, state: s } = i;
  const today = localDate(i.now);
  const out: Finding[] = [];
  const add = (f: Omit<Finding, "alert"> & { alert?: Omit<NonNullable<Finding["alert"]>, "key"> & { key?: string } }) =>
    out.push({
      ...f,
      alert: f.alert ? { ...f.alert, key: `${f.alert.type}:${cycle.id}:${f.alert.key ?? f.eventId ?? ""}` } : null,
    });
  const settled = s.cprStatus === "SETTLED";

  // ---- planting window ----
  const window = findWindow(i.windows, cycle.crop, cycle.seasonCode, i.plot.uf, i.plot.municipalityIbge);
  if (s.planting) {
    const check = checkPlanting(s.planting, window, cycle.seasonCode);
    if (check === "OUTSIDE" && window) {
      const { start, end } = windowDates(window, cycle.seasonCode);
      add({
        code: "PLANTED_OUTSIDE_WINDOW",
        message: `Planted ${s.planting.startedOn} to ${s.planting.finishedOn}, outside the window ${start} to ${end}`,
        eventId: s.planting.eventId,
        risk: { dimension: "PLANTING_WINDOW", points: 100 },
        alert: { type: "PLANTED_OUTSIDE_WINDOW", severity: "HIGH" },
      });
    } else if (check === "NO_WINDOW") {
      add({
        code: "NO_WINDOW_CONFIGURED",
        message: `No planting window configured for ${cycle.crop} ${cycle.seasonCode} in ${i.plot.uf}`,
        eventId: null,
        risk: { dimension: "PLANTING_WINDOW", points: 40 },
      });
    }
  } else if (window && today > windowDates(window, cycle.seasonCode).end) {
    add({
      code: "PLANTING_WINDOW_MISSED",
      message: `No planting recorded and the window closed on ${windowDates(window, cycle.seasonCode).end}`,
      eventId: null,
      risk: { dimension: "PLANTING_WINDOW", points: 80 },
      alert: { type: "PLANTING_WINDOW_MISSED", severity: "HIGH" },
    });
  }

  // ---- input applications ----
  const template = i.templates.find((t) => t.crop === cycle.crop);
  if (!template) {
    add({
      code: "NO_CHECKLIST",
      message: `No input checklist configured for ${cycle.crop}`,
      eventId: null,
      risk: { dimension: "INPUT_COMPLIANCE", points: 20 },
    });
  } else {
    for (const st of checklistStatus(template, s.planting?.startedOn ?? null, s.applications, today)) {
      if (st.status === "MISSING") {
        add({
          code: "APPLICATION_MISSING",
          message: `"${st.item.description}" not recorded (due by ${st.dueBy})`,
          eventId: null,
          risk: { dimension: "INPUT_COMPLIANCE", points: 35 },
          alert: { type: "APPLICATION_MISSING", severity: "WARNING", key: st.item.id },
        });
      } else if (st.status === "LATE") {
        add({
          code: "APPLICATION_LATE",
          message: `"${st.item.description}" applied outside its period (due by ${st.dueBy})`,
          eventId: st.eventId,
          risk: { dimension: "INPUT_COMPLIANCE", points: 15 },
          alert: { type: "APPLICATION_LATE", severity: "INFO", key: st.item.id },
        });
      }
    }
  }

  // ---- harvest and delivery ----
  if (s.harvest?.withoutPlan) {
    add({
      code: "HARVEST_NOT_PLANNED",
      message: "Harvest started without a declared harvest plan",
      eventId: s.harvest.eventId,
      risk: { dimension: "HARVEST_DELIVERY", points: 20 },
      alert: { type: "HARVEST_NOT_PLANNED", severity: "WARNING" },
    });
  }
  if (s.harvestPlan && !s.harvest && today > addDays(s.harvestPlan.plannedStart, 7)) {
    add({
      code: "HARVEST_OVERDUE",
      message: `Harvest was planned to start ${s.harvestPlan.plannedStart} and has not started`,
      eventId: s.harvestPlan.eventId,
      risk: { dimension: "HARVEST_DELIVERY", points: 30 },
      alert: { type: "HARVEST_OVERDUE", severity: "WARNING" },
    });
  }
  for (const d of s.deliveries) {
    if (!d.arrivedAt && i.now.getTime() > Date.parse(d.expectedArrivalAt) + DAY_MS) {
      add({
        code: "DELIVERY_OVERDUE",
        message: `Truck ${d.truckPlate} was expected ${d.expectedArrivalAt} and has not arrived`,
        eventId: d.dispatchedEventId,
        risk: { dimension: "HARVEST_DELIVERY", points: 25 },
        alert: { type: "DELIVERY_OVERDUE", severity: "WARNING" },
      });
    }
    const table = i.discountTables.find((t) => t.crop === cycle.crop);
    if (d.received && table) {
      const expected = expectedDiscountKg(d.received.grossKg, d.received, table);
      if (isTicketMismatch(d.received.grossKg, d.received.discountKg, expected)) {
        add({
          code: "QUALITY_TICKET_MISMATCH",
          message: `Ticket ${d.received.ticketNumber} discounts ${d.received.discountKg} kg; the table gives ${expected} kg`,
          eventId: d.received.eventId,
          risk: { dimension: "HARVEST_DELIVERY", points: 10 },
          alert: { type: "QUALITY_TICKET_MISMATCH", severity: "WARNING" },
        });
      }
    }
  }
  if (
    s.cpr &&
    !settled &&
    today > s.cpr.deliveryWindowEnd &&
    !isFulfilled(s.receivedNetKg, s.cpr.issuedKg, i.toleranceBps)
  ) {
    add({
      code: "DELIVERY_SHORTFALL",
      message: `Delivered ${s.receivedNetKg} of ${s.cpr.issuedKg} kg after the delivery window closed (${s.cpr.deliveryWindowEnd})`,
      eventId: null,
      risk: { dimension: "HARVEST_DELIVERY", points: 60 },
      alert: { type: "DELIVERY_SHORTFALL", severity: "HIGH" },
    });
  }

  // ---- informational ----
  if (s.cpr && !settled) {
    const daysLeft = daysBetween(today, s.cpr.dueDate);
    if (daysLeft <= 30) {
      add({
        code: "CPR_DUE_SOON",
        message: daysLeft < 0 ? `CPR due ${s.cpr.dueDate}, ${-daysLeft} days overdue` : `CPR due in ${daysLeft} days (${s.cpr.dueDate})`,
        eventId: s.cpr.eventId,
        risk: null,
        alert: { type: "CPR_DUE_SOON", severity: daysLeft < 0 ? "HIGH" : "WARNING" },
      });
    }
  }
  if (!settled) {
    for (const r of s.infoRequests) {
      add({
        code: "INFO_REQUEST_OPEN",
        message: `Information requested about ${r.topic}${r.dueDate ? ` by ${r.dueDate}` : ""}`,
        eventId: r.eventId,
        risk: null,
        alert: { type: "INFO_REQUEST_OPEN", severity: r.dueDate && today > r.dueDate ? "WARNING" : "INFO" },
      });
    }
  }

  return out;
}

export const RISK_WEIGHTS: Record<Dimension, number> = {
  PLANTING_WINDOW: 0.4,
  INPUT_COMPLIANCE: 0.3,
  HARVEST_DELIVERY: 0.3,
};

export type RiskGrade = "A" | "B" | "C" | "D";

export interface RiskAssessment {
  grade: RiskGrade;
  score: number;
  computedAt: string;
  dimensions: {
    dimension: Dimension;
    score: number;
    reasons: { code: string; message: string; eventId: string | null }[];
  }[];
}

/**
 * Score 0-100, higher is riskier. Each dimension caps at 100. The overall score is the
 * weighted average, but never below 80% of the worst dimension, so one severe problem
 * (e.g. planting outside the window) can't be averaged away.
 */
export function assessRisk(findings: Finding[], now: Date): RiskAssessment {
  const dimensions = (Object.keys(RISK_WEIGHTS) as Dimension[]).map((dimension) => {
    const own = findings.filter((f) => f.risk?.dimension === dimension);
    return {
      dimension,
      score: Math.min(100, own.reduce((sum, f) => sum + (f.risk?.points ?? 0), 0)),
      reasons: own.map((f) => ({ code: f.code, message: f.message, eventId: f.eventId })),
    };
  });
  const weighted = dimensions.reduce((sum, d) => sum + d.score * RISK_WEIGHTS[d.dimension], 0);
  const worst = Math.max(...dimensions.map((d) => d.score));
  const score = Math.round(Math.max(weighted, worst * 0.8));
  const grade: RiskGrade = score < 15 ? "A" : score < 35 ? "B" : score < 60 ? "C" : "D";
  return { grade, score, computedAt: now.toISOString(), dimensions };
}
