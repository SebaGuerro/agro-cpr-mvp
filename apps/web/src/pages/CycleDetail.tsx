import { Alert, Badge, Button, Card, Grid, Group, Progress, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { IconAlertTriangle, IconShieldCheck } from "@tabler/icons-react";
import { Link, useParams } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useActor, useAlerts, useCprRequests, useCycle, useCycleInsurers, useCycleTimeline, usePlot, useRisk } from "../api/queries";
import type { CropCycle, EventRecord } from "../api/types";
import { CprBadge, Empty, PageHeader, QueryGate, RiskBadge, SeverityBadge, StageBadge, StatCard } from "../components/common";
import { usePlotNames } from "../components/CyclesTable";
import { EventTimeline } from "../components/EventTimeline";
import { ApproveCprForm, FundingForm, InfoRequestForm, RejectCprForm, SettleCprForm } from "../components/forms/financier";
import { ClaimForm, ClaimSettleForm, PolicyForm, SaleForm } from "../components/forms/insurance";
import { ApplicationForm, CprRequestForm, DispatchForm, HarvestPlanForm, HarvestStartForm, LinkInsurerForm, PlantingForm } from "../components/forms/producer";
import { ArrivalForm, CdaForm, ReceiptForm, ReleaseForm, type TruckRef } from "../components/forms/warehouse";
import { fmtBrl, fmtDate, fmtDateTime, fmtHa, fmtKg, fmtPct, fmtSacas } from "../lib/format";
import { ALERT_LABEL, CAUSE_LABEL, COVERAGE_LABEL, CROP_LABEL, DIMENSION_LABEL } from "../lib/labels";

interface Truck extends TruckRef {
  arrivedAt: string | null;
  receivedNetKg: number | null;
  expectedArrivalAt: string;
}

/** Trucks and CDAs rebuilt from the timeline (voided events don't count). */
function logistics(cycle: CropCycle, events: EventRecord[]) {
  const live = events.filter((e) => !e.voided);
  const trucks = new Map<string, Truck>();
  for (const e of live) {
    const p = e.payload as Record<string, any>;
    if (e.eventType === "TRUCK_DISPATCHED") {
      trucks.set(p.deliveryId, { cycleId: cycle.id, crop: cycle.crop, deliveryId: p.deliveryId, truckPlate: p.truckPlate, estimatedKg: e.quantity ?? undefined, arrivedAt: null, receivedNetKg: null, expectedArrivalAt: p.expectedArrivalAt });
    }
    const t = p.deliveryId ? trucks.get(p.deliveryId) : undefined;
    if (t && e.eventType === "TRUCK_ARRIVED") t.arrivedAt = e.occurredAt;
    if (t && e.eventType === "GRAIN_RECEIVED") t.receivedNetKg = p.netKg;
  }
  const cdas = live.filter((e) => e.eventType === "CDA_ISSUED");
  return {
    trucks: [...trucks.values()],
    cdaNumbers: cdas.map((e) => String(e.payload.cdaNumber)),
    cdaKg: cdas.reduce((s, e) => s + (e.quantity ?? 0), 0),
  };
}

export function CycleDetailPage() {
  const { cycleId } = useParams({ strict: false }) as { cycleId: string };
  const cycle = useCycle(cycleId);
  return <QueryGate query={cycle}>{(c) => <CycleView cycle={c} />}</QueryGate>;
}

type Dialog =
  | { kind: "planting" | "application" | "harvestPlan" | "harvestStart" | "dispatch" | "cprRequest" | "linkInsurer" | "claim" | "funding" | "info" | "settle" | "cda" | "release" | "sale" | "policy" }
  | { kind: "approve" | "reject"; requestId: string }
  | { kind: "arrival" | "receipt"; truck: Truck }
  | { kind: "settleClaim"; claimId: string };

function CycleView({ cycle }: { cycle: CropCycle }) {
  const me = useActor();
  const plot = usePlot(cycle.plotId).data;
  const timeline = useCycleTimeline(cycle.id);
  const risk = useRisk(cycle.id);
  const alerts = useAlerts({ cycleId: cycle.id }).data ?? [];
  const requests = (useCprRequests("PENDING").data ?? []).filter((r) => r.cropCycleId === cycle.id);
  const insurers = useCycleInsurers(cycle.id).data ?? [];
  const plotName = usePlotNames();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);

  const events = timeline.data?.events ?? [];
  const { trucks, cdaNumbers, cdaKg } = logistics(cycle, events);
  const admin = me.role === "ADMIN";
  const isProducer = admin || (me.role === "PRODUCER" && me.orgId === cycle.producerOrgId);
  const isFinancier = admin || (me.role === "FINANCIER" && (cycle.cpr.financierOrgId === me.orgId || requests.some((r) => r.financierOrgId === me.orgId)));
  const isWarehouse = admin || (me.role === "WAREHOUSE" && cycle.cpr.warehouseOrgId === me.orgId);
  const isBuyer = admin || me.role === "BUYER";
  const isInsurer = admin || me.role === "INSURER";
  const s = cycle.stage;
  const cprOpen = cycle.cpr.status === "ISSUED" || cycle.cpr.status === "FUNDED";
  const received = cycle.fulfillment.deliveredNetKg;

  const actions: { key: Dialog["kind"]; label: string; show: boolean; variant?: string }[] = [
    { key: "planting", label: "Registrar plantio", show: isProducer && s === "CREATED" },
    { key: "application", label: "Aplicação de insumo", show: isProducer && ["CREATED", "PLANTED", "HARVEST_PLANNED", "HARVESTING"].includes(s) },
    { key: "harvestPlan", label: "Planejar colheita", show: isProducer && ["PLANTED", "HARVEST_PLANNED"].includes(s) },
    { key: "harvestStart", label: "Início da colheita", show: isProducer && ["PLANTED", "HARVEST_PLANNED"].includes(s) },
    { key: "dispatch", label: "Despachar caminhão", show: isProducer && cprOpen && ["HARVESTING", "DELIVERING", "DELIVERED"].includes(s) },
    { key: "cprRequest", label: "Solicitar CPR", show: isProducer && cycle.cpr.status === "NONE" && requests.length === 0 && ["CREATED", "PLANTED"].includes(s) },
    { key: "linkInsurer", label: "Vincular seguradora", show: isProducer && s !== "CLOSED", variant: "default" },
    { key: "claim", label: "Comunicar sinistro", show: isProducer && cycle.insurance.policies.length > 0, variant: "default" },
    { key: "funding", label: "Registrar desembolso", show: isFinancier && cprOpen },
    { key: "settle", label: "Liquidar CPR", show: isFinancier && cprOpen && ["DELIVERING", "DELIVERED"].includes(s) },
    { key: "info", label: "Pedir informação", show: isFinancier && s !== "CLOSED", variant: "default" },
    { key: "cda", label: "Emitir CDA/WA", show: isWarehouse && received > cdaKg },
    { key: "release", label: "Liberar grão", show: isWarehouse && cdaNumbers.length > 0 },
    { key: "sale", label: "Registrar venda", show: isBuyer && received > 0 },
    { key: "policy", label: "Emitir apólice", show: isInsurer && insurers.length > 0 },
  ];
  const visible = actions.filter((a) => a.show);

  return (
    <>
      <PageHeader
        title={plotName(cycle.plotId)}
        subtitle={
          <>
            {CROP_LABEL[cycle.crop]} · safra {cycle.seasonCode}
            {plot && (
              <>
                {" · "}
                <Link to="/talhoes/$plotId" params={{ plotId: plot.id }}>
                  ver talhão
                </Link>
              </>
            )}
          </>
        }
        actions={
          <>
            <StageBadge stage={cycle.stage} />
            <CprBadge status={cycle.cpr.status} />
            <RiskBadge grade={cycle.risk.grade} score={cycle.risk.score} />
          </>
        }
      />

      {visible.length > 0 && (
        <Group gap="xs" mb="md">
          {visible.map((a) => (
            <Button key={a.key} variant={a.variant ?? "light"} onClick={() => setDialog({ kind: a.key } as Dialog)}>
              {a.label}
            </Button>
          ))}
        </Group>
      )}

      {requests.map((r) => (
        <Alert key={r.id} color="indigo" mb="md" title="Pedido de CPR aguardando o financiador">
          <Group justify="space-between">
            <Text size="sm">
              {fmtKg(r.requestedKg)} até {fmtDate(r.dueDate)}.
            </Text>
            {isFinancier && (
              <Group gap="xs">
                <Button size="xs" onClick={() => setDialog({ kind: "approve", requestId: r.id })}>
                  Aprovar e emitir
                </Button>
                <Button size="xs" variant="default" onClick={() => setDialog({ kind: "reject", requestId: r.id })}>
                  Recusar
                </Button>
              </Group>
            )}
          </Group>
        </Alert>
      ))}

      <SimpleGrid cols={{ base: 2, md: 3, lg: 6 }} mb="lg">
        <StatCard label="Área" value={fmtHa(cycle.areaM2)} />
        <StatCard label="Potencial" value={fmtKg(cycle.potentialKg)} hint={`${cycle.expectedYieldKgPerHa} kg/ha · ${fmtSacas(cycle.potentialKg)}`} />
        <StatCard label="Elegível para CPR" value={fmtKg(cycle.eligibleKg)} hint={`haircut ${cycle.haircutBps / 100}%`} />
        <StatCard label="CPR emitida" value={fmtKg(cycle.cpr.issuedKg)} hint={cycle.cpr.cprNumber ? `${cycle.cpr.cprNumber} · vence ${fmtDate(cycle.cpr.dueDate)}` : "—"} />
        <StatCard
          label="Entregue (líquido)"
          value={fmtKg(received)}
          hint={
            cycle.cpr.issuedKg ? (
              <>
                {fmtPct(cycle.fulfillment.fulfilledBps)} do contratado
                <Progress mt={4} size="sm" value={Math.min(100, cycle.fulfillment.fulfilledBps / 100)} />
              </>
            ) : undefined
          }
        />
        <StatCard label="Desembolsado" value={fmtBrl(cycle.cpr.fundedBrlCents)} />
      </SimpleGrid>

      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card withBorder>
            <Title order={4} mb="md">
              Histórico
            </Title>
            <QueryGate query={timeline}>{(t) => <EventTimeline events={t.events} />}</QueryGate>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack>
            <Section title="Risco">
              <QueryGate query={risk}>
                {(r) => (
                  <Stack gap="sm">
                    <Group>
                      <RiskBadge grade={r.grade} score={r.score} />
                      <Text size="sm">Pontuação {r.score} de 100</Text>
                    </Group>
                    {r.dimensions.map((d) => (
                      <div key={d.dimension}>
                        <Group justify="space-between">
                          <Text size="sm" fw={500}>
                            {DIMENSION_LABEL[d.dimension]}
                          </Text>
                          <Text size="sm">{d.score}</Text>
                        </Group>
                        <Progress value={d.score} color={d.score >= 60 ? "red" : d.score >= 35 ? "orange" : d.score >= 15 ? "lime" : "green"} size="sm" />
                        {d.reasons.map((x, i) => (
                          <Text key={i} size="xs" c="dimmed" mt={2}>
                            • {x.message}
                          </Text>
                        ))}
                      </div>
                    ))}
                  </Stack>
                )}
              </QueryGate>
            </Section>

            <Section title={`Alertas abertos (${alerts.length})`}>
              {alerts.length === 0 ? (
                <Empty>Nenhum alerta aberto.</Empty>
              ) : (
                <Stack gap="xs">
                  {alerts.map((a) => (
                    <Group key={a.id} gap="xs" wrap="nowrap" align="flex-start">
                      <SeverityBadge severity={a.severity} />
                      <div>
                        <Text size="sm" fw={500}>
                          {ALERT_LABEL[a.type] ?? a.type}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {a.message}
                        </Text>
                      </div>
                    </Group>
                  ))}
                </Stack>
              )}
            </Section>

            {(trucks.length > 0 || isWarehouse) && (
              <Section title="Caminhões">
                {trucks.length === 0 ? (
                  <Empty>Nenhum caminhão despachado.</Empty>
                ) : (
                  <Table verticalSpacing={6}>
                    <Table.Tbody>
                      {trucks.map((t) => (
                        <Table.Tr key={t.deliveryId}>
                          <Table.Td>
                            <Text size="sm" fw={600}>
                              {t.truckPlate}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {t.receivedNetKg !== null ? `${fmtKg(t.receivedNetKg)} líquidos` : t.arrivedAt ? `chegou ${fmtDateTime(t.arrivedAt)}` : `previsto ${fmtDateTime(t.expectedArrivalAt)}`}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            {t.receivedNetKg !== null ? (
                              <Badge color="teal" variant="light">
                                Recebido
                              </Badge>
                            ) : isWarehouse && !t.arrivedAt ? (
                              <Button size="xs" onClick={() => setDialog({ kind: "arrival", truck: t })}>
                                Chegada
                              </Button>
                            ) : isWarehouse ? (
                              <Button size="xs" onClick={() => setDialog({ kind: "receipt", truck: t })}>
                                Classificar
                              </Button>
                            ) : (
                              <Badge variant="light">{t.arrivedAt ? "No armazém" : "A caminho"}</Badge>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </Section>
            )}

            <Section title="Seguro" icon={<IconShieldCheck size={18} />}>
              {insurers.length === 0 && cycle.insurance.policies.length === 0 ? (
                <Empty>Nenhuma seguradora vinculada.</Empty>
              ) : (
                <Stack gap="xs">
                  {insurers.length > 0 && (
                    <Text size="xs" c="dimmed">
                      Seguradoras vinculadas: {insurers.map((o) => o.name).join(", ")}
                    </Text>
                  )}
                  {cycle.insurance.policies.map((p) => (
                    <Text key={p.policyNumber} size="sm">
                      <b>{p.policyNumber}</b> — {COVERAGE_LABEL[p.coverage!]}, {fmtBrl(p.insuredBrlCents)} de {fmtDate(p.startsOn)} a {fmtDate(p.endsOn)}
                    </Text>
                  ))}
                  {cycle.insurance.claims.map((c) => (
                    <Group key={c.claimId} justify="space-between" wrap="nowrap">
                      <div>
                        <Text size="sm">
                          Sinistro: {CAUSE_LABEL[c.cause!] ?? c.cause} em {fmtDate(c.lossOn)}, perda estimada {fmtKg(c.estimatedLossKg)}
                        </Text>
                        <Text size="xs" c={c.settlement ? "dimmed" : "red"}>
                          {c.settlement ? (c.settlement.outcome === "PAID" ? `Indenizado ${fmtBrl(c.settlement.paidBrlCents)}` : "Recusado") : "Aguardando a seguradora"}
                        </Text>
                      </div>
                      {!c.settlement && isInsurer && (me.role === "ADMIN" || c.insurerOrgId === me.orgId) && (
                        <Button size="xs" onClick={() => setDialog({ kind: "settleClaim", claimId: c.claimId! })}>
                          Regular
                        </Button>
                      )}
                    </Group>
                  ))}
                  <Text size="xs" c="dimmed">
                    O seguro não altera a nota de risco.
                  </Text>
                </Stack>
              )}
            </Section>
          </Stack>
        </Grid.Col>
      </Grid>

      {cycle.risk.grade === "D" && (
        <Alert mt="lg" color="red" icon={<IconAlertTriangle />}>
          Nota D: veja os motivos no quadro de risco.
        </Alert>
      )}

      <Dialogs dialog={dialog} cycle={cycle} plot={plot} requests={requests} cdaNumbers={cdaNumbers} onClose={close} />
    </>
  );
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <Card withBorder>
      <Group gap="xs" mb="sm">
        {icon}
        <Title order={5}>{title}</Title>
      </Group>
      {children}
    </Card>
  );
}

function Dialogs({ dialog, cycle, plot, requests, cdaNumbers, onClose }: { dialog: Dialog | null; cycle: CropCycle; plot: ReturnType<typeof usePlot>["data"]; requests: ReturnType<typeof useCprRequests>["data"] & object; cdaNumbers: string[]; onClose(): void }) {
  if (!dialog) return null;
  const props = { cycle, plot, opened: true, onClose };
  switch (dialog.kind) {
    case "planting":
      return <PlantingForm {...props} />;
    case "application":
      return <ApplicationForm {...props} />;
    case "harvestPlan":
      return <HarvestPlanForm {...props} />;
    case "harvestStart":
      return <HarvestStartForm {...props} />;
    case "dispatch":
      return <DispatchForm {...props} />;
    case "cprRequest":
      return <CprRequestForm {...props} />;
    case "linkInsurer":
      return <LinkInsurerForm {...props} />;
    case "claim":
      return <ClaimForm {...props} />;
    case "funding":
      return <FundingForm {...props} />;
    case "info":
      return <InfoRequestForm {...props} />;
    case "settle":
      return <SettleCprForm {...props} />;
    case "cda":
      return <CdaForm cycle={cycle} opened onClose={onClose} />;
    case "release":
      return <ReleaseForm cycle={cycle} cdaNumbers={cdaNumbers} opened onClose={onClose} />;
    case "sale":
      return <SaleForm {...props} />;
    case "policy":
      return <PolicyForm {...props} />;
    case "approve":
    case "reject": {
      const request = requests.find((r) => r.id === dialog.requestId);
      if (!request) return null;
      return dialog.kind === "approve" ? <ApproveCprForm request={request} cycle={cycle} opened onClose={onClose} /> : <RejectCprForm request={request} opened onClose={onClose} />;
    }
    case "arrival":
      return <ArrivalForm truck={dialog.truck} opened onClose={onClose} />;
    case "receipt":
      return <ReceiptForm truck={dialog.truck} opened onClose={onClose} />;
    case "settleClaim": {
      const claim = cycle.insurance.claims.find((c) => c.claimId === dialog.claimId);
      return claim ? <ClaimSettleForm cycle={cycle} claim={claim} opened onClose={onClose} /> : null;
    }
  }
}
