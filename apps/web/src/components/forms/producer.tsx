import { Alert, Group, NumberInput, Select, SimpleGrid, Text, TextInput } from "@mantine/core";
import { DateInput, TimeInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import { useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { api, unwrap } from "../../api/client";
import { useActor, useConfig, useCycleInsurers, useWrite } from "../../api/queries";
import type { CropCycle, Plot } from "../../api/types";
import { buildEvent, notifyError, notifySaved, useRecordEvent } from "../../lib/events";
import { fmtDate, fmtHa, fmtKg, localIso, occurredOn, todayLocal } from "../../lib/format";
import { CATEGORY_LABEL, CROP_LABEL, CROPS, options } from "../../lib/labels";
import { cprVolumes, findWindow, isPlate, normalizePlate, windowDates } from "../../lib/rules";
import { DecimalInput, EvidenceInput, FormModal, KgInput, OrgSelect } from "../common";

export interface CycleFormProps {
  cycle: CropCycle;
  plot?: Plot;
  opened: boolean;
  onClose(): void;
}

const DATE = { valueFormat: "DD/MM/YYYY", placeholder: "dd/mm/aaaa" } as const;
const cycleSubject = (cycle: CropCycle) => ({ subjectType: "CROP_CYCLE" as const, subjectId: cycle.id });

export function PlantingForm({ cycle, plot, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const { windows } = useConfig();
  const form = useForm({
    initialValues: { cultivar: "", cycleDays: 120 as number | "", startedOn: null as string | null, finishedOn: null as string | null, areaHa: cycle.areaM2 / 10_000 as number | "" },
    validate: {
      cultivar: (v) => (v.trim() ? null : "Informe a cultivar"),
      startedOn: (v) => (v ? null : "Obrigatório"),
      finishedOn: (v, all) => (!v ? "Obrigatório" : all.startedOn && v < all.startedOn ? "Termina antes de começar" : null),
      cycleDays: (v) => (typeof v === "number" && v >= 30 && v <= 240 ? null : "Entre 30 e 240 dias"),
    },
  });
  const window = plot ? findWindow(windows, cycle.crop, cycle.seasonCode, plot.uf, plot.municipalityIbge) : null;
  const dates = window ? windowDates(window, cycle.seasonCode) : null;
  const { startedOn, finishedOn } = form.values;
  const outside = dates && ((startedOn && (startedOn < dates.start || startedOn > dates.end)) || (finishedOn && (finishedOn < dates.start || finishedOn > dates.end)));

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Registrar plantio"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, {
            ...cycleSubject(cycle),
            eventType: "PLANTING_RECORDED",
            occurredAt: occurredOn(v.finishedOn!),
            quantity: Math.round(Number(v.areaHa) * 10_000),
            unit: "M2",
            payload: { crop: cycle.crop, cultivar: v.cultivar.trim(), cycleDays: Number(v.cycleDays), startedOn: v.startedOn, finishedOn: v.finishedOn },
          }),
        );
        onClose();
      }}
    >
      {dates ? (
        <Alert color={outside ? "red" : "green"} icon={outside ? <IconAlertTriangle /> : <IconInfoCircle />}>
          Janela de plantio ({window!.isSample ? "amostra" : window!.source}): {fmtDate(dates.start)} a {fmtDate(dates.end)}.
          {outside && " As datas estão fora da janela: o ciclo receberá alerta e nota de risco alta."}
        </Alert>
      ) : (
        <Alert color="gray" icon={<IconInfoCircle />}>
          Não há janela de plantio configurada para {CROP_LABEL[cycle.crop]} nesta região.
        </Alert>
      )}
      <TextInput label="Cultivar" required {...form.getInputProps("cultivar")} />
      <SimpleGrid cols={2}>
        <DateInput label="Início do plantio" required {...DATE} {...form.getInputProps("startedOn")} maxDate={todayLocal()} />
        <DateInput label="Fim do plantio" required {...DATE} {...form.getInputProps("finishedOn")} maxDate={todayLocal()} />
      </SimpleGrid>
      <SimpleGrid cols={2}>
        <NumberInput label="Ciclo da cultivar (dias)" min={30} max={240} {...form.getInputProps("cycleDays")} />
        <DecimalInput label="Área plantada (ha)" max={cycle.areaM2 / 10_000} {...form.getInputProps("areaHa")} />
      </SimpleGrid>
    </FormModal>
  );
}

export function ApplicationForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const { checklists } = useConfig();
  const items = checklists.find((c) => c.crop === cycle.crop)?.items ?? [];
  const [evidence, setEvidence] = useState<string | null>(null);
  const form = useForm({
    initialValues: {
      checklistItemId: null as string | null,
      category: null as string | null,
      productName: "",
      activeIngredient: "",
      amount: "" as number | "",
      unit: "L",
      appliedOn: null as string | null,
      areaHa: cycle.areaM2 / 10_000 as number | "",
      nfeKey: "",
      recipe: "",
    },
    validate: {
      category: (v) => (v ? null : "Obrigatório"),
      productName: (v) => (v.trim() ? null : "Obrigatório"),
      amount: (v) => (typeof v === "number" && v > 0 ? null : "Informe a quantidade"),
      appliedOn: (v) => (v ? null : "Obrigatório"),
      nfeKey: (v) => (!v || v.replace(/\D/g, "").length === 44 ? null : "A chave tem 44 dígitos"),
    },
  });

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Registrar aplicação de insumo"
      size="lg"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        if (!evidence) return notifyError(new Error("Anexe a nota fiscal, o receituário ou uma foto: a evidência é obrigatória"));
        const v = form.getValues();
        const amount = Number(v.amount);
        const quantity = v.unit === "L" ? Math.round(amount * 1000) : Math.round(amount);
        await record.mutateAsync(
          buildEvent(me, {
            ...cycleSubject(cycle),
            eventType: "INPUT_APPLICATION_RECORDED",
            occurredAt: occurredOn(v.appliedOn!),
            quantity,
            unit: v.unit === "L" ? "ML" : v.unit,
            evidenceHash: evidence,
            payload: {
              checklistItemId: v.checklistItemId,
              category: v.category,
              productName: v.productName.trim(),
              activeIngredient: v.activeIngredient.trim() || null,
              appliedAreaM2: Math.round(Number(v.areaHa) * 10_000),
              appliedOn: v.appliedOn,
              nfeKey: v.nfeKey.replace(/\D/g, "") || null,
              agronomistRecipeNumber: v.recipe.trim() || null,
            },
          }),
        );
        onClose();
      }}
    >
      <Select
        label="Item do checklist"
        description="Deixe em branco para uma aplicação fora do checklist"
        clearable
        data={items.map((i) => ({ value: i.id, label: `${i.description} (dia ${i.fromDay} a ${i.toDay} do plantio)` }))}
        value={form.values.checklistItemId}
        onChange={(id) => {
          form.setFieldValue("checklistItemId", id);
          const item = items.find((i) => i.id === id);
          if (item) form.setFieldValue("category", item.category);
        }}
      />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select label="Categoria" required data={options(CATEGORY_LABEL)} {...form.getInputProps("category")} />
        <DateInput label="Data da aplicação" required {...DATE} maxDate={todayLocal()} {...form.getInputProps("appliedOn")} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Produto" required {...form.getInputProps("productName")} />
        <TextInput label="Ingrediente ativo" {...form.getInputProps("activeIngredient")} />
      </SimpleGrid>
      <SimpleGrid cols={3}>
        <DecimalInput label="Quantidade total" required {...form.getInputProps("amount")} />
        <Select label="Unidade" data={["L", "ML", "KG"]} allowDeselect={false} {...form.getInputProps("unit")} />
        <DecimalInput label="Área aplicada (ha)" {...form.getInputProps("areaHa")} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Chave da NF-e" placeholder="44 dígitos" {...form.getInputProps("nfeKey")} />
        <TextInput label="Receituário agronômico" {...form.getInputProps("recipe")} />
      </SimpleGrid>
      <EvidenceInput label="Evidência" required onHash={setEvidence} />
    </FormModal>
  );
}

export function HarvestPlanForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const form = useForm({
    initialValues: { plannedStart: null as string | null, plannedEnd: null as string | null, expectedKg: (cycle.cpr.issuedKg ?? cycle.potentialKg) as number | "" },
    validate: {
      plannedStart: (v) => (v ? null : "Obrigatório"),
      plannedEnd: (v, all) => (!v ? "Obrigatório" : all.plannedStart && v < all.plannedStart ? "Termina antes de começar" : null),
      expectedKg: (v) => (typeof v === "number" && v > 0 ? null : "Informe a produção esperada"),
    },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Planejar a colheita"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, { ...cycleSubject(cycle), eventType: "HARVEST_PLANNED", quantity: Number(v.expectedKg), unit: "KG", payload: { plannedStart: v.plannedStart, plannedEnd: v.plannedEnd } }),
        );
        onClose();
      }}
    >
      <SimpleGrid cols={2}>
        <DateInput label="Início previsto" required {...DATE} {...form.getInputProps("plannedStart")} />
        <DateInput label="Fim previsto" required {...DATE} {...form.getInputProps("plannedEnd")} />
      </SimpleGrid>
      <KgInput label="Produção esperada" required value={form.values.expectedKg} onChange={(v) => form.setFieldValue("expectedKg", v)} error={form.errors.expectedKg} />
    </FormModal>
  );
}

export function HarvestStartForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const [startedOn, setStartedOn] = useState<string | null>(todayLocal());
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Início da colheita"
      loading={record.isPending}
      onSubmit={async () => {
        if (!startedOn) return;
        await record.mutateAsync(buildEvent(me, { ...cycleSubject(cycle), eventType: "HARVEST_STARTED", occurredAt: occurredOn(startedOn), payload: { startedOn } }));
        onClose();
      }}
    >
      <DateInput label="Data de início" required {...DATE} maxDate={todayLocal()} value={startedOn} onChange={setStartedOn} />
    </FormModal>
  );
}

/** Phone-first: big inputs, few fields. The warehouse is always the CPR's. */
export function DispatchForm({ cycle, opened, onClose }: CycleFormProps) {
  const me = useActor();
  const record = useRecordEvent();
  const form = useForm({
    initialValues: { plate: "", estimatedKg: "" as number | "", arrivalDate: todayLocal() as string | null, arrivalTime: "" },
    validate: {
      plate: (v) => (isPlate(normalizePlate(v)) ? null : "Placa no formato ABC1D23 ou ABC1234"),
      estimatedKg: (v) => (typeof v === "number" && v > 0 ? null : "Informe o peso estimado"),
      arrivalDate: (v) => (v ? null : "Obrigatório"),
      arrivalTime: (v) => (/^\d{2}:\d{2}$/.test(v) ? null : "Informe a hora"),
    },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Despachar caminhão"
      submitLabel="Despachar"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, {
            ...cycleSubject(cycle),
            eventType: "TRUCK_DISPATCHED",
            quantity: Number(v.estimatedKg),
            unit: "KG",
            payload: { deliveryId: uuidv7(), truckPlate: normalizePlate(v.plate), warehouseOrgId: cycle.cpr.warehouseOrgId, expectedArrivalAt: localIso(v.arrivalDate!, v.arrivalTime) },
          }),
        );
        form.reset();
        onClose();
      }}
    >
      <TextInput label="Placa" size="lg" required placeholder="ABC1D23" autoCapitalize="characters" {...form.getInputProps("plate")} />
      <KgInput label="Peso estimado da carga" size="lg" required value={form.values.estimatedKg} onChange={(v) => form.setFieldValue("estimatedKg", v)} error={form.errors.estimatedKg} />
      <Group grow>
        <DateInput label="Chegada prevista" size="lg" required {...DATE} {...form.getInputProps("arrivalDate")} />
        <TimeInput label="Hora" size="lg" required {...form.getInputProps("arrivalTime")} />
      </Group>
      <Text size="sm" c="dimmed">
        Destino: o armazém designado na CPR.
      </Text>
    </FormModal>
  );
}

export function CprRequestForm({ cycle, opened, onClose }: CycleFormProps) {
  const save = useWrite((body: { cropCycleId: string; requestedKg: number; warehouseOrgId: string; financierOrgId: string; dueDate: string }) =>
    unwrap(api.POST("/v1/cpr-requests", { body })),
  );
  const form = useForm({
    initialValues: { requestedKg: cycle.eligibleKg as number | "", warehouseOrgId: null as string | null, financierOrgId: null as string | null, dueDate: null as string | null },
    validate: {
      requestedKg: (v) => (typeof v === "number" && v > 0 ? (v > cycle.eligibleKg ? `Máximo elegível: ${fmtKg(cycle.eligibleKg)}` : null) : "Obrigatório"),
      warehouseOrgId: (v) => (v ? null : "Escolha o armazém"),
      financierOrgId: (v) => (v ? null : "Escolha o financiador"),
      dueDate: (v) => (v ? null : "Obrigatório"),
    },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Solicitar CPR"
      submitLabel="Enviar pedido"
      loading={save.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        try {
          await save.mutateAsync({ cropCycleId: cycle.id, requestedKg: Number(v.requestedKg), warehouseOrgId: v.warehouseOrgId!, financierOrgId: v.financierOrgId!, dueDate: v.dueDate! });
          notifySaved("Pedido de CPR enviado ao financiador");
          onClose();
        } catch (err) {
          notifyError(err);
        }
      }}
    >
      <Alert icon={<IconInfoCircle />} color="blue">
        Potencial {fmtKg(cycle.potentialKg)}; com o haircut de {cycle.haircutBps / 100}%, o volume elegível é {fmtKg(cycle.eligibleKg)}.
      </Alert>
      <KgInput label="Volume da CPR" required max={cycle.eligibleKg} value={form.values.requestedKg} onChange={(v) => form.setFieldValue("requestedKg", v)} error={form.errors.requestedKg} />
      <OrgSelect kind="WAREHOUSE" label="Armazém de entrega" required value={form.values.warehouseOrgId} onChange={(v) => form.setFieldValue("warehouseOrgId", v)} />
      <OrgSelect kind="FINANCIER" label="Financiador" required value={form.values.financierOrgId} onChange={(v) => form.setFieldValue("financierOrgId", v)} />
      <DateInput label="Vencimento" required {...DATE} minDate={todayLocal()} {...form.getInputProps("dueDate")} />
    </FormModal>
  );
}

export function LinkInsurerForm({ cycle, opened, onClose }: CycleFormProps) {
  const linked = useCycleInsurers(cycle.id).data ?? [];
  const [insurerOrgId, setInsurer] = useState<string | null>(null);
  const save = useWrite((id: string) => unwrap(api.POST("/v1/crop-cycles/{cycleId}/insurers", { params: { path: { cycleId: cycle.id } }, body: { insurerOrgId: id } })));
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Vincular seguradora"
      submitLabel="Vincular"
      loading={save.isPending}
      onSubmit={async () => {
        if (!insurerOrgId) return;
        try {
          await save.mutateAsync(insurerOrgId);
          notifySaved("Seguradora vinculada: ela passa a ver este ciclo e pode emitir a apólice");
          onClose();
        } catch (err) {
          notifyError(err);
        }
      }}
    >
      <Text size="sm">A seguradora vinculada vê os dados deste ciclo (plantio, insumos, entregas e risco) e pode emitir a apólice.</Text>
      {linked.length > 0 && <Text size="sm" c="dimmed">Já vinculadas: {linked.map((o) => o.name).join(", ")}</Text>}
      <OrgSelect kind="INSURER" label="Seguradora" required value={insurerOrgId} onChange={setInsurer} />
    </FormModal>
  );
}

// ---------- farms, plots and cycles ----------

export function FarmForm({ opened, onClose }: { opened: boolean; onClose(): void }) {
  const me = useActor();
  const save = useWrite((body: { name: string; uf: string; municipalityIbge: string; producerOrgId?: string }) => unwrap(api.POST("/v1/farms", { body: body as never })));
  const form = useForm({
    initialValues: { name: "", uf: "", municipalityIbge: "", producerOrgId: null as string | null },
    validate: {
      name: (v) => (v.trim() ? null : "Obrigatório"),
      uf: (v) => (/^[A-Z]{2}$/.test(v) ? null : "UF com 2 letras"),
      municipalityIbge: (v) => (/^\d{7}$/.test(v) ? null : "Código IBGE de 7 dígitos"),
      producerOrgId: (v) => (me.role === "ADMIN" && !v ? "Escolha o produtor" : null),
    },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Nova fazenda"
      submitLabel="Criar"
      loading={save.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        try {
          await save.mutateAsync({ name: v.name.trim(), uf: v.uf, municipalityIbge: v.municipalityIbge, ...(v.producerOrgId && { producerOrgId: v.producerOrgId }) });
          notifySaved("Fazenda criada");
          form.reset();
          onClose();
        } catch (err) {
          notifyError(err);
        }
      }}
    >
      {me.role === "ADMIN" && <OrgSelect kind="PRODUCER" label="Produtor" required value={form.values.producerOrgId} onChange={(v) => form.setFieldValue("producerOrgId", v)} />}
      <TextInput label="Nome da fazenda" required {...form.getInputProps("name")} />
      <SimpleGrid cols={2}>
        <TextInput label="UF" required maxLength={2} {...form.getInputProps("uf")} onChange={(e) => form.setFieldValue("uf", e.currentTarget.value.toUpperCase())} />
        <TextInput label="Município (código IBGE)" required placeholder="5107925" {...form.getInputProps("municipalityIbge")} />
      </SimpleGrid>
    </FormModal>
  );
}

export function PlotForm({ farm, opened, onClose }: { farm: { id: string; name: string; uf: string; municipalityIbge: string }; opened: boolean; onClose(): void }) {
  const me = useActor();
  const record = useRecordEvent();
  const form = useForm({
    initialValues: { name: "", areaHa: "" as number | "", carCode: "", municipalityIbge: farm.municipalityIbge, digitalTwinRef: "" },
    validate: {
      name: (v) => (v.trim() ? null : "Obrigatório"),
      areaHa: (v) => (typeof v === "number" && v > 0 ? null : "Informe a área"),
      municipalityIbge: (v) => (/^\d{7}$/.test(v) ? null : "Código IBGE de 7 dígitos"),
    },
  });
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={`Novo talhão — ${farm.name}`}
      submitLabel="Cadastrar"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, {
            eventType: "PLOT_REGISTERED",
            subjectType: "PLOT",
            subjectId: uuidv7(),
            quantity: Math.round(Number(v.areaHa) * 10_000),
            unit: "M2",
            payload: { farmId: farm.id, name: v.name.trim(), carCode: v.carCode.trim() || null, municipalityIbge: v.municipalityIbge, uf: farm.uf, geometry: null, digitalTwinRef: v.digitalTwinRef.trim() || null },
          }),
        );
        form.reset();
        onClose();
      }}
    >
      <TextInput label="Nome do talhão" required {...form.getInputProps("name")} />
      <SimpleGrid cols={2}>
        <DecimalInput label="Área (ha)" required {...form.getInputProps("areaHa")} />
        <TextInput label="Município (IBGE)" {...form.getInputProps("municipalityIbge")} />
      </SimpleGrid>
      <TextInput label="Código CAR" description="Um CAR já cadastrado por outro produtor é recusado (dupla garantia)" {...form.getInputProps("carCode")} />
      <TextInput label="Referência no gêmeo digital" description="Id do talhão no gêmeo digital (análise de solo)" {...form.getInputProps("digitalTwinRef")} />
    </FormModal>
  );
}

export function NewCycleForm({ plot, opened, onClose }: { plot: Plot; opened: boolean; onClose(): void }) {
  const { haircuts } = useConfig();
  const save = useWrite((body: { plotId: string; crop: string; seasonCode: string; expectedYieldKgPerHa: number }) => unwrap(api.POST("/v1/crop-cycles", { body: body as never })));
  const year = Number(todayLocal().slice(0, 4));
  const seasons = [year - 1, year, year + 1].flatMap((y) => ["SAFRA", "SAFRINHA", "UNICA"].map((k) => `${y}/${String((y + 1) % 100).padStart(2, "0")}-${k}`));
  const form = useForm({
    initialValues: { crop: "SOJA", seasonCode: `${year}/${String((year + 1) % 100).padStart(2, "0")}-SAFRA`, yieldSacas: 60 as number | "" },
    validate: { yieldSacas: (v) => (typeof v === "number" && v > 0 ? null : "Informe a produtividade esperada") },
  });
  const haircutBps = haircuts.find((h) => h.crop === form.values.crop)?.haircutBps ?? 8_000;
  const yieldKg = typeof form.values.yieldSacas === "number" ? Math.round(form.values.yieldSacas * 60) : 0;
  const volumes = cprVolumes(plot.areaM2, yieldKg, haircutBps);
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={`Novo ciclo — ${plot.name}`}
      submitLabel="Criar ciclo"
      loading={save.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        try {
          const v = form.getValues();
          await save.mutateAsync({ plotId: plot.id, crop: v.crop, seasonCode: v.seasonCode, expectedYieldKgPerHa: Math.round(Number(v.yieldSacas) * 60) });
          notifySaved("Ciclo criado");
          onClose();
        } catch (err) {
          notifyError(err);
        }
      }}
    >
      <SimpleGrid cols={2}>
        <Select label="Cultura" data={options(CROP_LABEL, CROPS)} allowDeselect={false} {...form.getInputProps("crop")} />
        <Select label="Safra" data={seasons} allowDeselect={false} searchable {...form.getInputProps("seasonCode")} />
      </SimpleGrid>
      <DecimalInput label="Produtividade esperada (sc/ha)" description="Do agrônomo; define o potencial e o limite da CPR" required {...form.getInputProps("yieldSacas")} />
      <Alert icon={<IconInfoCircle />} color="blue">
        {fmtHa(plot.areaM2)} × {yieldKg} kg/ha = potencial de {fmtKg(volumes.potentialKg)}. Com haircut de {haircutBps / 100}%, até {fmtKg(volumes.eligibleKg)} podem ir para a CPR.
      </Alert>
    </FormModal>
  );
}

export function SoilAnalysisForm({ plot, opened, onClose }: { plot: Plot; opened: boolean; onClose(): void }) {
  const me = useActor();
  const record = useRecordEvent();
  const [evidence, setEvidence] = useState<string | null>(null);
  const form = useForm({
    initialValues: { labName: "", sampledOn: null as string | null, ph: "" as number | "", organicMatterPct: "" as number | "", clayPct: "" as number | "", digitalTwinRef: "" },
    validate: { labName: (v) => (v.trim() ? null : "Obrigatório"), sampledOn: (v) => (v ? null : "Obrigatório") },
  });
  const num = (v: number | "") => (v === "" ? null : v);
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Anexar análise de solo"
      loading={record.isPending}
      onSubmit={async () => {
        if (form.validate().hasErrors) return;
        if (!evidence) return notifyError(new Error("Anexe o laudo do laboratório"));
        const v = form.getValues();
        await record.mutateAsync(
          buildEvent(me, {
            eventType: "SOIL_ANALYSIS_ATTACHED",
            subjectType: "PLOT",
            subjectId: plot.id,
            evidenceHash: evidence,
            payload: { labName: v.labName.trim(), sampledOn: v.sampledOn, digitalTwinRef: v.digitalTwinRef.trim() || null, ph: num(v.ph), organicMatterPct: num(v.organicMatterPct), clayPct: num(v.clayPct) },
          }),
        );
        onClose();
      }}
    >
      <TextInput label="Laboratório" required {...form.getInputProps("labName")} />
      <DateInput label="Data da coleta" required {...DATE} maxDate={todayLocal()} {...form.getInputProps("sampledOn")} />
      <SimpleGrid cols={3}>
        <DecimalInput label="pH" max={14} {...form.getInputProps("ph")} />
        <DecimalInput label="Matéria orgânica (%)" max={100} {...form.getInputProps("organicMatterPct")} />
        <DecimalInput label="Argila (%)" max={100} {...form.getInputProps("clayPct")} />
      </SimpleGrid>
      <TextInput label="Referência no gêmeo digital" {...form.getInputProps("digitalTwinRef")} />
      <EvidenceInput label="Laudo" required onHash={setEvidence} description="PDF do laudo do laboratório" />
    </FormModal>
  );
}
