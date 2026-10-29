import { Alert, Select, SimpleGrid, Text, Textarea, TextInput } from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { IconInfoCircle } from "@tabler/icons-react";
import { useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { api, unwrap } from "../../api/client";
import { useActor, useWrite } from "../../api/queries";
import type { CprRequest, CropCycle } from "../../api/types";
import { buildEvent, notifyError, notifySaved, useRecordEvent } from "../../lib/events";
import { fmtDate, fmtKg, occurredOn, todayLocal } from "../../lib/format";
import { INFO_TOPIC_LABEL, options } from "../../lib/labels";
import { BrlInput, FormModal, KgInput } from "../common";
import type { CycleFormProps } from "./producer";

const DATE = { valueFormat: "DD/MM/YYYY", placeholder: "dd/mm/aaaa" } as const;
const cycleSubject = (cycle: CropCycle) => ({ subjectType: "CROP_CYCLE" as const, subjectId: cycle.id });

/** Approving issues the CPR on-chain (CPR_ISSUED), capped at the eligible volume. */
export function ApproveCprForm({ request, cycle, opened, onClose }: { request: CprRequest; cycle?: CropCycle; opened: boolean; onClose(): void }) {
  const save = useWrite((body: { eventId: string; cprNumber: string; issuedKg: number; deliveryWindowStart: string; deliveryWindowEnd: string }) =>
    unwrap(api.POST("/v1/cpr-requests/{requestId}/approve", { params: { path: { requestId: request.id } }, body })),
  );
  const form = useForm({
    initialValues: { cprNumber: "", issuedKg: request.requestedKg as number | "", deliveryWindowStart: null as string | null, deliveryWindowEnd: null as string | null },
    validate: {
      cprNumber: (v) => (v.trim() ? null : "Obrigatório"),
      issuedKg: (v) => (typeof v !== "number" || v <= 0 ? "Obrigatório" : cycle && v > cycle.eligibleKg ? `Acima do elegível (${fmtKg(cycle.eligibleKg)})` : null),
      deliveryWindowStart: (v) => (v ? null : "Obrigatório"),
      deliveryWindowEnd: (v, all) => (!v ? "Obrigatório" : all.deliveryWindowStart && v < all.deliveryWindowStart ? "Termina antes de começar" : null),
    },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Aprovar e emitir a CPR"
      submitLabel="Emitir CPR"
      loading={save.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        try {
          await save.mutateAsync({ eventId: uuidv7(), cprNumber: v.cprNumber.trim(), issuedKg: Number(v.issuedKg), deliveryWindowStart: v.deliveryWindowStart!, deliveryWindowEnd: v.deliveryWindowEnd! });
          notifySaved("CPR emitida. O token será criado na blockchain em instantes.");
          onClose();
        } catch (err) {
          notifyError(err);
        }
      }}
    >
      <Alert icon={<IconInfoCircle />}>
        Pedido de {fmtKg(request.requestedKg)}, vencimento {fmtDate(request.dueDate)}.{cycle && ` Elegível: ${fmtKg(cycle.eligibleKg)}.`} Só pode existir uma CPR por talhão e safra.
      </Alert>
      <TextInput label="Número da CPR" required {...form.getInputProps("cprNumber")} />
      <KgInput label="Volume emitido" required value={form.values.issuedKg} onChange={(v) => form.setFieldValue("issuedKg", v)} error={form.errors.issuedKg} />
      <SimpleGrid cols={2}>
        <DateInput label="Entrega a partir de" required {...DATE} {...form.getInputProps("deliveryWindowStart")} />
        <DateInput label="Entrega até" required {...DATE} {...form.getInputProps("deliveryWindowEnd")} />
      </SimpleGrid>
    </FormModal>
  );
}

export function RejectCprForm({ request, opened, onClose }: { request: CprRequest; opened: boolean; onClose(): void }) {
  const [reason, setReason] = useState("");
  const save = useWrite((r: string) => unwrap(api.POST("/v1/cpr-requests/{requestId}/reject", { params: { path: { requestId: request.id } }, body: { reason: r } })));
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Recusar pedido de CPR"
      submitLabel="Recusar"
      loading={save.isPending}
      onSubmit={async () => {
        if (reason.trim().length < 5) return notifyError(new Error("Explique o motivo (mínimo 5 caracteres)"));
        try {
          await save.mutateAsync(reason.trim());
          notifySaved("Pedido recusado");
          onClose();
        } catch (err) {
          notifyError(err);
        }
      }}
    >
      <Textarea label="Motivo" required minRows={3} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
    </FormModal>
  );
}

export function FundingForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const form = useForm({
    initialValues: { cents: "" as number | "", purpose: "INPUTS", reference: "" },
    validate: { cents: (v) => (typeof v === "number" && v > 0 ? null : "Informe o valor") },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Registrar desembolso"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, { ...cycleSubject(cycle), eventType: "FUNDING_DISBURSED", quantity: Number(v.cents), unit: "BRL_CENTS", payload: { financierOrgId: cycle.cpr.financierOrgId, purpose: v.purpose, reference: v.reference.trim() || null } }),
        );
        onClose();
      }}
    >
      <BrlInput label="Valor" required cents={form.values.cents} onChangeCents={(v) => form.setFieldValue("cents", v)} error={form.errors.cents} />
      <Select label="Finalidade" data={[{ value: "INPUTS", label: "Insumos" }, { value: "OPERATIONS", label: "Operação" }, { value: "OTHER", label: "Outra" }]} allowDeselect={false} {...form.getInputProps("purpose")} />
      <TextInput label="Referência (TED, contrato)" {...form.getInputProps("reference")} />
    </FormModal>
  );
}

export function InfoRequestForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const form = useForm({
    initialValues: { topic: "PLANTING", message: "", dueDate: null as string | null },
    validate: { message: (v) => (v.trim() ? null : "Escreva o pedido") },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Pedir informação ao produtor"
      submitLabel="Enviar pedido"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, { ...cycleSubject(cycle), eventType: "INFO_REQUESTED", payload: { requestedFromOrgId: cycle.producerOrgId, topic: v.topic, message: v.message.trim(), dueDate: v.dueDate } }),
        );
        onClose();
      }}
    >
      <Select label="Assunto" data={options(INFO_TOPIC_LABEL)} allowDeselect={false} {...form.getInputProps("topic")} />
      <Textarea label="Pedido" required minRows={3} {...form.getInputProps("message")} />
      <DateInput label="Responder até" {...DATE} minDate={todayLocal()} clearable {...form.getInputProps("dueDate")} />
      <Text size="xs" c="dimmed">
        O pedido abre um alerta para o produtor até a CPR ser liquidada.
      </Text>
    </FormModal>
  );
}

export function SettleCprForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const delivered = cycle.fulfillment.deliveredNetKg;
  const full = cycle.stage === "DELIVERED";
  const form = useForm({ initialValues: { settledOn: todayLocal() as string | null, cashCents: "" as number | "" } });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Liquidar a CPR"
      submitLabel="Liquidar"
      loading={record.isPending}
      onSubmit={async () => {
        const v = form.getValues();
        if (!v.settledOn) return;
        await record.mutateAsync(
          buildEvent(me, {
            ...cycleSubject(cycle),
            eventType: "CPR_SETTLED",
            occurredAt: occurredOn(v.settledOn),
            quantity: delivered,
            unit: "KG",
            payload: { outcome: full ? "FULLY_DELIVERED" : "PARTIALLY_DELIVERED_CASH_SETTLED", settledOn: v.settledOn, cashSettledBrlCents: full || v.cashCents === "" ? null : v.cashCents },
          }),
        );
        onClose();
      }}
    >
      <Alert icon={<IconInfoCircle />} color={full ? "green" : "orange"}>
        Entregue {fmtKg(delivered)} de {fmtKg(cycle.fulfillment.pledgedKg)}.{" "}
        {full ? "Entrega completa (dentro da tolerância)." : "Entrega parcial: a diferença é liquidada em dinheiro."}
      </Alert>
      <DateInput label="Data da liquidação" required {...DATE} maxDate={todayLocal()} {...form.getInputProps("settledOn")} />
      {!full && <BrlInput label="Valor liquidado em dinheiro" cents={form.values.cashCents} onChangeCents={(v) => form.setFieldValue("cashCents", v)} />}
    </FormModal>
  );
}
