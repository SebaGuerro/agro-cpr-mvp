import type { EventRecord } from "../api/types";
import { fmtBrl, fmtDate, fmtDateTime, fmtHa, fmtKg } from "./format";
import { CATEGORY_LABEL, CAUSE_LABEL, COVERAGE_LABEL, INFO_TOPIC_LABEL } from "./labels";

/** One line describing an event's content, for the timeline. */
export function eventSummary(e: EventRecord): string {
  const p = e.payload as Record<string, any>;
  const qty = e.unit === "KG" ? fmtKg(e.quantity) : e.unit === "M2" ? fmtHa(e.quantity) : e.unit === "BRL_CENTS" ? fmtBrl(e.quantity) : e.unit === "ML" ? `${((e.quantity ?? 0) / 1000).toLocaleString("pt-BR")} L` : "";
  switch (e.eventType) {
    case "PLOT_REGISTERED":
      return `${p.name}, ${qty}${p.carCode ? `, CAR ${p.carCode}` : ""}`;
    case "SOIL_ANALYSIS_ATTACHED":
      return `${p.labName}, coleta ${fmtDate(p.sampledOn)}${p.ph != null ? `, pH ${p.ph}` : ""}${p.clayPct != null ? `, argila ${p.clayPct}%` : ""}`;
    case "CPR_ISSUED":
      return `${p.cprNumber}: ${qty} (elegível ${fmtKg(p.eligibleKg)}), vence ${fmtDate(p.dueDate)}`;
    case "FUNDING_DISBURSED":
      return `${qty}${p.reference ? ` (${p.reference})` : ""}`;
    case "PLANTING_RECORDED":
      return `${p.cultivar}, ${fmtDate(p.startedOn)} a ${fmtDate(p.finishedOn)}, ${qty}`;
    case "INPUT_APPLICATION_RECORDED":
      return `${CATEGORY_LABEL[p.category] ?? p.category}: ${p.productName}, ${qty} em ${fmtDate(p.appliedOn)}`;
    case "HARVEST_PLANNED":
      return `${fmtDate(p.plannedStart)} a ${fmtDate(p.plannedEnd)}, esperado ${qty}`;
    case "HARVEST_STARTED":
      return `Início em ${fmtDate(p.startedOn)}`;
    case "TRUCK_DISPATCHED":
      return `${p.truckPlate}, ${qty} estimados, chegada prevista ${fmtDateTime(p.expectedArrivalAt)}`;
    case "TRUCK_ARRIVED":
      return `${p.truckPlate}`;
    case "GRAIN_RECEIVED":
      return `Ticket ${p.ticketNumber}: bruto ${fmtKg(p.grossKg)}, umidade ${p.moisturePct}%, impureza ${p.impurityPct}%, desconto ${fmtKg(p.discountKg)}, líquido ${fmtKg(p.netKg)}`;
    case "CDA_ISSUED":
      return `CDA ${p.cdaNumber} / WA ${p.waNumber}: ${qty}`;
    case "GRAIN_RELEASED":
      return `${qty} do CDA ${p.cdaNumber}`;
    case "SALE_RECORDED":
      return `${qty} a ${fmtBrl(p.priceBrlCentsPerSaca)}/sc${p.contractNumber ? ` (${p.contractNumber})` : ""}`;
    case "INFO_REQUESTED":
      return `${INFO_TOPIC_LABEL[p.topic] ?? p.topic}: ${p.message}`;
    case "CPR_SETTLED":
      return `${p.outcome === "FULLY_DELIVERED" ? "Entrega completa" : "Parcial, saldo em dinheiro"}: ${qty}${p.cashSettledBrlCents ? ` + ${fmtBrl(p.cashSettledBrlCents)}` : ""}`;
    case "EVENT_CORRECTED":
      return `${p.reason}`;
    case "EVENT_VOIDED":
      return `${p.reason}`;
    case "POLICY_ISSUED":
      return `${p.policyNumber} (${COVERAGE_LABEL[p.coverage] ?? p.coverage}): ${qty} segurados, prêmio ${fmtBrl(p.premiumBrlCents)}`;
    case "CLAIM_FILED":
      return `${CAUSE_LABEL[p.cause] ?? p.cause} em ${fmtDate(p.lossOn)}: perda estimada ${qty}`;
    case "CLAIM_SETTLED":
      return p.outcome === "PAID" ? `Indenizado: ${qty}` : `Recusado${p.reason ? `: ${p.reason}` : ""}`;
    default:
      return qty;
  }
}
