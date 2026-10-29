import { Alert, NumberInput, SimpleGrid, Text, Textarea, TextInput } from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { IconInfoCircle } from "@tabler/icons-react";
import { useState } from "react";
import { useActor } from "../../api/queries";
import type { EventRecord } from "../../api/types";
import { buildEvent, notifyError, useRecordEvent } from "../../lib/events";
import { occurredOn } from "../../lib/format";
import { EVENT_LABEL } from "../../lib/labels";
import { FormModal } from "../common";

const DATE = { valueFormat: "DD/MM/YYYY", placeholder: "dd/mm/aaaa" } as const;

/** Payload fields that can be edited as a single text or number box. */
function editableFields(payload: Record<string, unknown>) {
  return Object.entries(payload).filter(([, v]) => v === null || typeof v === "string" || typeof v === "number");
}

/**
 * EVENT_CORRECTED for the original org (or an admin): only changed fields are sent.
 * The backend replays the whole history with the change, so a correction that
 * breaks a later step is refused.
 */
export function CorrectionForm({ event, opened, onClose }: { event: EventRecord; opened: boolean; onClose(): void }) {
  const me = useActor();
  const record = useRecordEvent();
  const fields = editableFields(event.payload);
  const [values, setValues] = useState<Record<string, string | number | null>>(Object.fromEntries(fields) as Record<string, string | number | null>);
  const [quantity, setQuantity] = useState<number | "">(event.quantity ?? "");
  const [date, setDate] = useState<string | null>(event.occurredAt.slice(0, 10));
  const [reason, setReason] = useState("");

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={`Corrigir: ${EVENT_LABEL[event.eventType] ?? event.eventType}`}
      submitLabel="Registrar correção"
      size="lg"
      loading={record.isPending}
      onSubmit={async () => {
        if (reason.trim().length < 5) return notifyError(new Error("Explique o motivo da correção (mínimo 5 caracteres)"));
        const payload: Record<string, unknown> = {};
        for (const [k, orig] of fields) {
          const now = values[k];
          if (now !== orig) payload[k] = typeof orig === "number" ? (now === "" || now === null ? null : Number(now)) : now === "" ? null : now;
        }
        const corrected: Record<string, unknown> = {};
        if (Object.keys(payload).length) corrected.payload = payload;
        if (event.quantity !== null && quantity !== event.quantity && quantity !== "") corrected.quantity = quantity;
        if (date && date !== event.occurredAt.slice(0, 10)) corrected.occurredAt = occurredOn(date);
        if (!Object.keys(corrected).length) return notifyError(new Error("Nada foi alterado"));
        await record.mutateAsync(
          buildEvent(me, { subjectType: event.subjectType, subjectId: event.subjectId, eventType: "EVENT_CORRECTED", refEventId: event.id, payload: { reason: reason.trim(), corrected } }),
        );
        onClose();
      }}
    >
      <Alert icon={<IconInfoCircle />}>O registro original continua no histórico e na blockchain; a correção é um novo registro ligado a ele.</Alert>
      <SimpleGrid cols={2}>
        <DateInput label="Data do fato" {...DATE} value={date} onChange={setDate} />
        {event.quantity !== null && <NumberInput label={`Quantidade (${event.unit})`} decimalSeparator="," thousandSeparator="." value={quantity} onChange={(v) => setQuantity(typeof v === "number" ? v : "")} />}
      </SimpleGrid>
      {fields.map(([k, orig]) =>
        typeof orig === "number" ? (
          <NumberInput key={k} label={k} decimalSeparator="," thousandSeparator="." value={values[k] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [k]: typeof v === "number" ? v : null }))} />
        ) : (
          <TextInput key={k} label={k} value={(values[k] as string | null) ?? ""} onChange={(e) => setValues((s) => ({ ...s, [k]: e.currentTarget.value }))} />
        ),
      )}
      <Textarea label="Motivo" required minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
    </FormModal>
  );
}

/** EVENT_VOIDED (admin only): the event stops counting; it stays in the history. */
export function VoidForm({ event, opened, onClose }: { event: EventRecord; opened: boolean; onClose(): void }) {
  const me = useActor();
  const record = useRecordEvent();
  const [reason, setReason] = useState("");
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={`Anular: ${EVENT_LABEL[event.eventType] ?? event.eventType}`}
      submitLabel="Anular"
      loading={record.isPending}
      onSubmit={async () => {
        if (reason.trim().length < 5) return notifyError(new Error("Explique o motivo (mínimo 5 caracteres)"));
        await record.mutateAsync(buildEvent(me, { subjectType: event.subjectType, subjectId: event.subjectId, eventType: "EVENT_VOIDED", refEventId: event.id, payload: { reason: reason.trim() } }));
        onClose();
      }}
    >
      <Text size="sm">O registro deixa de contar nos cálculos, mas continua visível no histórico, marcado como anulado.</Text>
      <Textarea label="Motivo" required minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
    </FormModal>
  );
}
