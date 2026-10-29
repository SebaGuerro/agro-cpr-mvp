import { Alert, Select, SimpleGrid, Text, Textarea, TextInput } from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { IconInfoCircle } from "@tabler/icons-react";
import { useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { useActor, useCycleInsurers } from "../../api/queries";
import type { CropCycle } from "../../api/types";
import { buildEvent, notifyError, useRecordEvent } from "../../lib/events";
import { fmtBrl, fmtKg, occurredOn, todayLocal } from "../../lib/format";
import { CAUSE_LABEL, COVERAGE_LABEL, options } from "../../lib/labels";
import { BrlInput, EvidenceInput, FormModal, KgInput, OrgSelect } from "../common";
import type { CycleFormProps } from "./producer";

const DATE = { valueFormat: "DD/MM/YYYY", placeholder: "dd/mm/aaaa" } as const;
type Claim = CropCycle["insurance"]["claims"][number];

export function PolicyForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const linked = useCycleInsurers(cycle.id).data ?? [];
  const [evidence, setEvidence] = useState<string | null>(null);
  const form = useForm({
    initialValues: {
      insurerOrgId: me.role === "INSURER" ? me.orgId : (null as string | null),
      policyNumber: "",
      coverage: "MULTIRRISCO",
      insuredCents: "" as number | "",
      insuredKg: (cycle.cpr.issuedKg ?? "") as number | "",
      premiumCents: "" as number | "",
      startsOn: null as string | null,
      endsOn: null as string | null,
    },
    validate: {
      insurerOrgId: (v) => (v ? null : "Escolha a seguradora"),
      policyNumber: (v) => (v.trim() ? null : "Obrigatório"),
      insuredCents: (v) => (typeof v === "number" && v > 0 ? null : "Obrigatório"),
      premiumCents: (v) => (typeof v === "number" ? null : "Obrigatório"),
      startsOn: (v) => (v ? null : "Obrigatório"),
      endsOn: (v, all) => (!v ? "Obrigatório" : all.startsOn && v < all.startsOn ? "Termina antes de começar" : null),
    },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Emitir apólice"
      submitLabel="Emitir"
      size="lg"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, {
            subjectType: "CROP_CYCLE",
            subjectId: cycle.id,
            eventType: "POLICY_ISSUED",
            quantity: Number(v.insuredCents),
            unit: "BRL_CENTS",
            evidenceHash: evidence,
            payload: {
              insurerOrgId: v.insurerOrgId,
              policyNumber: v.policyNumber.trim(),
              coverage: v.coverage,
              insuredKg: v.insuredKg === "" ? null : v.insuredKg,
              premiumBrlCents: Number(v.premiumCents),
              startsOn: v.startsOn,
              endsOn: v.endsOn,
            },
          }),
        );
        onClose();
      }}
    >
      {me.role === "ADMIN" && (
        <OrgSelect kind="INSURER" label="Seguradora" required only={linked.map((o) => o.id)} value={form.values.insurerOrgId} onChange={(v) => form.setFieldValue("insurerOrgId", v)} />
      )}
      <SimpleGrid cols={2}>
        <TextInput label="Número da apólice" required {...form.getInputProps("policyNumber")} />
        <Select label="Cobertura" data={options(COVERAGE_LABEL)} allowDeselect={false} {...form.getInputProps("coverage")} />
      </SimpleGrid>
      <SimpleGrid cols={2}>
        <BrlInput label="Importância segurada" required cents={form.values.insuredCents} onChangeCents={(v) => form.setFieldValue("insuredCents", v)} error={form.errors.insuredCents} />
        <BrlInput label="Prêmio" required cents={form.values.premiumCents} onChangeCents={(v) => form.setFieldValue("premiumCents", v)} error={form.errors.premiumCents} />
      </SimpleGrid>
      <KgInput label="Produção segurada" description="Opcional; para coberturas de produtividade" value={form.values.insuredKg} onChange={(v) => form.setFieldValue("insuredKg", v)} />
      <SimpleGrid cols={2}>
        <DateInput label="Vigência de" required {...DATE} {...form.getInputProps("startsOn")} />
        <DateInput label="Vigência até" required {...DATE} {...form.getInputProps("endsOn")} />
      </SimpleGrid>
      <EvidenceInput label="Apólice (documento)" onHash={setEvidence} description="Opcional" />
    </FormModal>
  );
}

export function ClaimForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const policies = cycle.insurance.policies;
  const [evidence, setEvidence] = useState<string | null>(null);
  const form = useForm({
    initialValues: { policyNumber: policies[0]?.policyNumber ?? null, cause: "SECA", lossOn: null as string | null, lossKg: "" as number | "", description: "" },
    validate: {
      policyNumber: (v) => (v ? null : "Escolha a apólice"),
      lossOn: (v, all) => {
        if (!v) return "Obrigatório";
        const p = policies.find((x) => x.policyNumber === all.policyNumber);
        return p && (v < p.startsOn! || v > p.endsOn!) ? "Fora da vigência da apólice" : null;
      },
      lossKg: (v) => (typeof v === "number" && v > 0 ? null : "Informe a perda estimada"),
      description: (v) => (v.trim() ? null : "Descreva o ocorrido"),
    },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Comunicar sinistro"
      submitLabel="Comunicar"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, {
            subjectType: "CROP_CYCLE",
            subjectId: cycle.id,
            eventType: "CLAIM_FILED",
            quantity: Number(v.lossKg),
            unit: "KG",
            evidenceHash: evidence,
            payload: { claimId: uuidv7(), policyNumber: v.policyNumber, cause: v.cause, lossOn: v.lossOn, description: v.description.trim() },
          }),
        );
        onClose();
      }}
    >
      <Select label="Apólice" required data={policies.map((p) => ({ value: p.policyNumber!, label: `${p.policyNumber} — ${COVERAGE_LABEL[p.coverage!] ?? p.coverage}` }))} {...form.getInputProps("policyNumber")} />
      <SimpleGrid cols={2}>
        <Select label="Causa" data={options(CAUSE_LABEL)} allowDeselect={false} {...form.getInputProps("cause")} />
        <DateInput label="Data da perda" required {...DATE} maxDate={todayLocal()} {...form.getInputProps("lossOn")} />
      </SimpleGrid>
      <KgInput label="Perda estimada" required value={form.values.lossKg} onChange={(v) => form.setFieldValue("lossKg", v)} error={form.errors.lossKg} />
      <Textarea label="O que aconteceu" required minRows={3} {...form.getInputProps("description")} />
      <EvidenceInput label="Fotos ou laudo" onHash={setEvidence} description="Opcional" />
      <Text size="xs" c="dimmed">
        O financiador e a seguradora recebem um alerta. Sem resposta em 30 dias, um novo alerta é aberto.
      </Text>
    </FormModal>
  );
}

export function ClaimSettleForm({ cycle, claim, opened, onClose }: { cycle: CropCycle; claim: Claim; opened: boolean; onClose(): void }) {
  const me = useActor();
  const record = useRecordEvent();
  const [evidence, setEvidence] = useState<string | null>(null);
  const form = useForm({
    initialValues: { outcome: "PAID", paidCents: "" as number | "", assessedLossKg: (claim.estimatedLossKg ?? "") as number | "", settledOn: todayLocal() as string | null, reason: "" },
  });
  const v = form.values;
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={`Regular sinistro — apólice ${claim.policyNumber}`}
      submitLabel="Registrar"
      loading={record.isPending}
      onSubmit={async () => {
        const v = form.getValues();
        if (!v.settledOn) return;
        if (v.outcome === "PAID" && (typeof v.paidCents !== "number" || v.paidCents <= 0)) return notifyError(new Error("Informe o valor da indenização"));
        if (v.outcome === "DENIED" && !v.reason.trim()) return notifyError(new Error("Explique a recusa"));
        await record.mutateAsync(
          buildEvent(me, {
            subjectType: "CROP_CYCLE",
            subjectId: cycle.id,
            eventType: "CLAIM_SETTLED",
            occurredAt: occurredOn(v.settledOn),
            quantity: v.outcome === "PAID" ? Number(v.paidCents) : 0,
            unit: "BRL_CENTS",
            evidenceHash: evidence,
            payload: { claimId: claim.claimId, outcome: v.outcome, assessedLossKg: v.assessedLossKg === "" ? null : v.assessedLossKg, settledOn: v.settledOn, reason: v.reason.trim() || null },
          }),
        );
        onClose();
      }}
    >
      <Alert icon={<IconInfoCircle />}>
        {CAUSE_LABEL[claim.cause!] ?? claim.cause} em {claim.lossOn}; perda estimada pelo produtor: {fmtKg(claim.estimatedLossKg)}.
      </Alert>
      <Select label="Decisão" data={[{ value: "PAID", label: "Indenizar" }, { value: "DENIED", label: "Recusar" }]} allowDeselect={false} {...form.getInputProps("outcome")} />
      {v.outcome === "PAID" && <BrlInput label="Indenização paga" required cents={v.paidCents} onChangeCents={(x) => form.setFieldValue("paidCents", x)} />}
      <KgInput label="Perda apurada na vistoria" value={v.assessedLossKg} onChange={(x) => form.setFieldValue("assessedLossKg", x)} />
      <DateInput label="Data" required {...DATE} maxDate={todayLocal()} {...form.getInputProps("settledOn")} />
      <Textarea label={v.outcome === "DENIED" ? "Motivo da recusa" : "Observação"} required={v.outcome === "DENIED"} {...form.getInputProps("reason")} />
      <EvidenceInput label="Laudo de vistoria" onHash={setEvidence} description="Opcional" />
      {v.outcome === "PAID" && typeof v.paidCents === "number" && <Text size="sm">Total: {fmtBrl(v.paidCents)}</Text>}
    </FormModal>
  );
}

export function SaleForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const form = useForm({
    initialValues: { buyerOrgId: me.role === "BUYER" ? me.orgId : (null as string | null), kg: "" as number | "", priceCentsPerSaca: "" as number | "", contract: "" },
    validate: {
      buyerOrgId: (v) => (v ? null : "Escolha o comprador"),
      kg: (v) => (typeof v === "number" && v > 0 ? null : "Obrigatório"),
      priceCentsPerSaca: (v) => (typeof v === "number" && v > 0 ? null : "Obrigatório"),
    },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Registrar venda"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, {
            subjectType: "CROP_CYCLE",
            subjectId: cycle.id,
            eventType: "SALE_RECORDED",
            quantity: Number(v.kg),
            unit: "KG",
            payload: { buyerOrgId: v.buyerOrgId, contractNumber: v.contract.trim() || null, priceBrlCentsPerSaca: Number(v.priceCentsPerSaca) },
          }),
        );
        onClose();
      }}
    >
      {me.role === "ADMIN" && <OrgSelect kind="BUYER" label="Comprador" required value={form.values.buyerOrgId} onChange={(v) => form.setFieldValue("buyerOrgId", v)} />}
      <KgInput label="Volume" required value={form.values.kg} onChange={(v) => form.setFieldValue("kg", v)} error={form.errors.kg} description={`Recebido no armazém: ${fmtKg(cycle.fulfillment.deliveredNetKg)}`} />
      <BrlInput label="Preço por saca (60 kg)" required cents={form.values.priceCentsPerSaca} onChangeCents={(v) => form.setFieldValue("priceCentsPerSaca", v)} error={form.errors.priceCentsPerSaca} />
      <TextInput label="Número do contrato" {...form.getInputProps("contract")} />
    </FormModal>
  );
}
