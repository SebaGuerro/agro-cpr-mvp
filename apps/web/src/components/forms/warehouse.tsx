import { Alert, Group, SimpleGrid, Text, TextInput } from "@mantine/core";
import { DateInput, TimeInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { IconInfoCircle } from "@tabler/icons-react";
import { useActor, useConfig } from "../../api/queries";
import type { CropCycle } from "../../api/types";
import { buildEvent, useRecordEvent } from "../../lib/events";
import { fmtKg, localIso, nowLocalIso, todayLocal } from "../../lib/format";
import { expectedDiscountKg } from "../../lib/rules";
import { DecimalInput, FormModal, KgInput, OrgSelect } from "../common";

const DATE = { valueFormat: "DD/MM/YYYY", placeholder: "dd/mm/aaaa" } as const;
const pad = (n: number) => String(n).padStart(2, "0");
function nowHHmm() {
  const d = new Date(Date.now() - 3 * 3600_000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export interface TruckRef {
  cycleId: string;
  crop: string;
  deliveryId: string;
  truckPlate: string;
  estimatedKg?: number;
}

/** Phone-first: confirm the truck at the gate. */
export function ArrivalForm({ truck, opened, onClose }: { truck: TruckRef; opened: boolean; onClose(): void }) {
  const me = useActor();
  const record = useRecordEvent();
  const form = useForm({ initialValues: { date: todayLocal() as string | null, time: nowHHmm() } });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={`Chegada do caminhão ${truck.truckPlate}`}
      submitLabel="Confirmar chegada"
      loading={record.isPending}
      onSubmit={async () => {
        const v = form.getValues();
        if (!v.date || !v.time) return;
        const at = localIso(v.date, v.time);
        await record.mutateAsync(
          buildEvent(me, {
            subjectType: "CROP_CYCLE",
            subjectId: truck.cycleId,
            eventType: "TRUCK_ARRIVED",
            occurredAt: at > nowLocalIso() ? nowLocalIso() : at,
            payload: { deliveryId: truck.deliveryId, truckPlate: truck.truckPlate },
          }),
        );
        onClose();
      }}
    >
      <Group grow>
        <DateInput label="Data" size="lg" {...DATE} maxDate={todayLocal()} {...form.getInputProps("date")} />
        <TimeInput label="Hora" size="lg" {...form.getInputProps("time")} />
      </Group>
    </FormModal>
  );
}

/** Scale ticket and classification. The discount is suggested from the discount table; the warehouse's own number wins. */
export function ReceiptForm({ truck, opened, onClose }: { truck: TruckRef; opened: boolean; onClose(): void }) {
  const me = useActor();
  const record = useRecordEvent();
  const { discounts } = useConfig();
  const table = discounts.find((t) => t.crop === truck.crop);
  const form = useForm({
    initialValues: { ticket: "", grossKg: (truck.estimatedKg ?? "") as number | "", moisture: "" as number | "", impurity: "" as number | "", damaged: 0 as number | "", discountKg: "" as number | "" },
    validate: {
      ticket: (v) => (v.trim() ? null : "Obrigatório"),
      grossKg: (v) => (typeof v === "number" && v > 0 ? null : "Obrigatório"),
      moisture: (v) => (typeof v === "number" ? null : "Obrigatório"),
      impurity: (v) => (typeof v === "number" ? null : "Obrigatório"),
    },
  });
  const totals = (v: typeof form.values) => {
    const suggested =
      table && typeof v.grossKg === "number" && typeof v.moisture === "number" && typeof v.impurity === "number"
        ? expectedDiscountKg(v.grossKg, { moisturePct: v.moisture, impurityPct: v.impurity, damagedPct: Number(v.damaged || 0) }, table)
        : null;
    const discount = typeof v.discountKg === "number" ? v.discountKg : (suggested ?? 0);
    return { suggested, discount, net: typeof v.grossKg === "number" ? v.grossKg - discount : null };
  };
  const v = form.values;
  const { suggested, net } = totals(v);

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={`Classificação — ${truck.truckPlate}`}
      submitLabel="Registrar recebimento"
      loading={record.isPending}
      onSubmit={async () => {
        const v = form.getValues();
        const { discount, net } = totals(v);
        if (form.validate().hasErrors || net === null || net < 0) return;
        await record.mutateAsync(
          buildEvent(me, {
            subjectType: "CROP_CYCLE",
            subjectId: truck.cycleId,
            eventType: "GRAIN_RECEIVED",
            quantity: net,
            unit: "KG",
            payload: {
              deliveryId: truck.deliveryId,
              ticketNumber: v.ticket.trim(),
              grossKg: v.grossKg,
              moisturePct: v.moisture,
              impurityPct: v.impurity,
              damagedPct: Number(v.damaged || 0),
              discountKg: discount,
              netKg: net,
            },
          }),
        );
        onClose();
      }}
    >
      <TextInput label="Número do ticket" size="lg" required {...form.getInputProps("ticket")} />
      <KgInput label="Peso bruto" size="lg" required value={v.grossKg} onChange={(x) => form.setFieldValue("grossKg", x)} error={form.errors.grossKg} />
      <SimpleGrid cols={3}>
        <DecimalInput label="Umidade (%)" size="lg" max={100} {...form.getInputProps("moisture")} />
        <DecimalInput label="Impureza (%)" size="lg" max={100} {...form.getInputProps("impurity")} />
        <DecimalInput label="Avariados (%)" size="lg" max={100} {...form.getInputProps("damaged")} />
      </SimpleGrid>
      <KgInput
        label="Desconto"
        size="lg"
        placeholder={suggested !== null ? String(suggested) : undefined}
        description={suggested !== null ? `Pela tabela: ${fmtKg(suggested)}. Deixe em branco para usar a tabela.` : "Sem tabela de descontos para esta cultura: informe o desconto."}
        value={v.discountKg}
        onChange={(x) => form.setFieldValue("discountKg", x)}
      />
      <Alert icon={<IconInfoCircle />} color={net !== null && net < 0 ? "red" : "blue"}>
        Peso líquido: <b>{fmtKg(net)}</b>
      </Alert>
    </FormModal>
  );
}

export function CdaForm({ cycle, opened, onClose }: { cycle: CropCycle; opened: boolean; onClose(): void }) {
  const me = useActor();
  const record = useRecordEvent();
  const available = cycle.fulfillment.deliveredNetKg;
  const form = useForm({
    initialValues: { cdaNumber: "", waNumber: "", kg: available as number | "", issuedOn: todayLocal() as string | null },
    validate: { cdaNumber: (x) => (x.trim() ? null : "Obrigatório"), waNumber: (x) => (x.trim() ? null : "Obrigatório"), kg: (x) => (typeof x === "number" && x > 0 ? null : "Obrigatório") },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Emitir CDA/WA"
      submitLabel="Emitir"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const x = form.getValues();
        await record.mutateAsync(
          buildEvent(me, { subjectType: "CROP_CYCLE", subjectId: cycle.id, eventType: "CDA_ISSUED", quantity: Number(x.kg), unit: "KG", payload: { cdaNumber: x.cdaNumber.trim(), waNumber: x.waNumber.trim(), issuedOn: x.issuedOn } }),
        );
        onClose();
      }}
    >
      <Text size="sm">Grão líquido recebido: {fmtKg(available)}. O total em CDAs não pode passar disso.</Text>
      <SimpleGrid cols={2}>
        <TextInput label="Número do CDA" required {...form.getInputProps("cdaNumber")} />
        <TextInput label="Número do WA" required {...form.getInputProps("waNumber")} />
      </SimpleGrid>
      <KgInput label="Volume" required value={form.values.kg} onChange={(x) => form.setFieldValue("kg", x)} error={form.errors.kg} />
      <DateInput label="Data de emissão" {...DATE} maxDate={todayLocal()} {...form.getInputProps("issuedOn")} />
    </FormModal>
  );
}

export function ReleaseForm({ cycle, cdaNumbers, opened, onClose }: { cycle: CropCycle; cdaNumbers: string[]; opened: boolean; onClose(): void }) {
  const me = useActor();
  const record = useRecordEvent();
  const form = useForm({
    initialValues: { cdaNumber: cdaNumbers[0] ?? "", releasedToOrgId: null as string | null, kg: "" as number | "", order: "" },
    validate: { cdaNumber: (x) => (x.trim() ? null : "Obrigatório"), releasedToOrgId: (x) => (x ? null : "Escolha o comprador"), kg: (x) => (typeof x === "number" && x > 0 ? null : "Obrigatório") },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Liberar grão"
      submitLabel="Liberar"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const x = form.getValues();
        await record.mutateAsync(
          buildEvent(me, {
            subjectType: "CROP_CYCLE",
            subjectId: cycle.id,
            eventType: "GRAIN_RELEASED",
            quantity: Number(x.kg),
            unit: "KG",
            payload: { cdaNumber: x.cdaNumber.trim(), releasedToOrgId: x.releasedToOrgId, releaseOrderNumber: x.order.trim() || null },
          }),
        );
        onClose();
      }}
    >
      <TextInput label="Número do CDA" required description={cdaNumbers.length ? `CDAs deste ciclo: ${cdaNumbers.join(", ")}` : undefined} {...form.getInputProps("cdaNumber")} />
      <OrgSelect kind="BUYER" label="Liberado para" required value={form.values.releasedToOrgId} onChange={(x) => form.setFieldValue("releasedToOrgId", x)} />
      <KgInput label="Volume" required value={form.values.kg} onChange={(x) => form.setFieldValue("kg", x)} error={form.errors.kg} />
      <TextInput label="Ordem de liberação" {...form.getInputProps("order")} />
    </FormModal>
  );
}
