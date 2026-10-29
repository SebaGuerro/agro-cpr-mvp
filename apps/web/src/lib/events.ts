import { CanonicalEvent, type EventType } from "@agro-cpr/spec";
import { notifications } from "@mantine/notifications";
import { v7 as uuidv7 } from "uuid";
import { api, ApiProblem, unwrap } from "../api/client";
import { useWrite } from "../api/queries";
import type { Me } from "../api/types";
import { nowLocalIso } from "./format";
import { EVENT_LABEL, PROBLEM_LABEL } from "./labels";

export interface EventDraft {
  eventType: EventType;
  subjectType: "PLOT" | "CROP_CYCLE";
  subjectId: string;
  quantity?: number | null;
  unit?: string | null;
  occurredAt?: string;
  evidenceHash?: string | null;
  refEventId?: string | null;
  payload: Record<string, unknown>;
}

/**
 * A canonical event from the signed-in user, checked against the shared Zod schema
 * before it leaves the browser. The id is a fresh UUIDv7, which is also the
 * idempotency key, so a retried submit can't record the event twice.
 */
export function buildEvent(me: Me, d: EventDraft): CanonicalEvent {
  const candidate = {
    id: uuidv7(),
    subjectType: d.subjectType,
    subjectId: d.subjectId,
    actorRole: me.role,
    actorOrgId: me.orgId,
    occurredAt: d.occurredAt ?? nowLocalIso(),
    eventType: d.eventType,
    quantity: d.quantity ?? null,
    unit: d.unit ?? null,
    evidenceHash: d.evidenceHash ?? null,
    refEventId: d.refEventId ?? null,
    payload: d.payload,
  };
  const parsed = CanonicalEvent.safeParse(candidate);
  if (!parsed.success) {
    throw new ApiProblem(
      "VALIDATION_FAILED",
      "Confira os campos",
      422,
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return parsed.data;
}

export function problemMessage(err: unknown): string {
  if (err instanceof ApiProblem) {
    const head = PROBLEM_LABEL[err.code] ?? err.code;
    const details = err.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    return `${head}. ${err.message}${details ? ` (${details})` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function notifyError(err: unknown) {
  notifications.show({ color: "red", title: "Não foi possível salvar", message: problemMessage(err), autoClose: 8000 });
}

export function notifySaved(message: string) {
  notifications.show({ color: "green", title: "Salvo", message });
}

/** Records one event; the toast names it, and the API's error is shown in Portuguese. */
export function useRecordEvent() {
  return useWrite(async (event: CanonicalEvent) => {
    try {
      const saved = await unwrap(api.POST("/v1/events", { body: event as never }));
      notifySaved(`${EVENT_LABEL[event.eventType] ?? event.eventType}: registro salvo. Ele vai para a blockchain em instantes.`);
      return saved;
    } catch (err) {
      notifyError(err);
      throw err;
    }
  });
}
