import { Badge, Button, Card, Grid, Group, Select, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { IconPlus, IconTruckDelivery } from "@tabler/icons-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useActor, useCycles, useFarms, usePlot, usePlots, usePlotTimeline } from "../api/queries";
import type { Farm, Plot } from "../api/types";
import { Empty, PageHeader, QueryGate, StatCard } from "../components/common";
import { CyclesTable } from "../components/CyclesTable";
import { EventTimeline } from "../components/EventTimeline";
import { DispatchForm, FarmForm, NewCycleForm, PlotForm, SoilAnalysisForm } from "../components/forms/producer";
import { fmtDate, fmtHa } from "../lib/format";
import { CROP_LABEL } from "../lib/labels";

export function ProducerHomePage() {
  const me = useActor();
  const farms = useFarms();
  const plots = usePlots().data ?? [];
  const cycles = useCycles().data ?? [];
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<{ kind: "farm" } | { kind: "plot"; farm: Farm } | { kind: "cycle"; plot: Plot } | null>(null);
  const close = () => setDialog(null);

  return (
    <>
      <PageHeader
        title={me.role === "ADMIN" ? "Fazendas e talhões" : me.orgName}
        subtitle="Cadastre a terra uma vez; cada safra vira um ciclo com potencial, CPR e acompanhamento"
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setDialog({ kind: "farm" })}>
            Nova fazenda
          </Button>
        }
      />
      <SimpleGrid cols={{ base: 2, sm: 4 }} mb="lg">
        <StatCard label="Fazendas" value={farms.data?.length ?? "—"} />
        <StatCard label="Talhões" value={plots.length} hint={fmtHa(plots.reduce((s, p) => s + p.areaM2, 0))} />
        <StatCard label="Ciclos" value={cycles.length} />
        <StatCard label="CPRs ativas" value={cycles.filter((c) => c.cpr.status === "ISSUED" || c.cpr.status === "FUNDED").length} />
      </SimpleGrid>

      <Card withBorder mb="lg">
        <Title order={4} mb="sm">
          Ciclos
        </Title>
        <CyclesTable cycles={cycles} />
      </Card>

      <QueryGate query={farms}>
        {(items) =>
          items.length === 0 ? (
            <Empty>Nenhuma fazenda ainda. Comece criando uma.</Empty>
          ) : (
            <Stack>
              {items.map((farm) => {
                const farmPlots = plots.filter((p) => p.farmId === farm.id);
                return (
                  <Card withBorder key={farm.id}>
                    <Group justify="space-between" mb="sm">
                      <div>
                        <Title order={4}>{farm.name}</Title>
                        <Text size="sm" c="dimmed">
                          {farm.uf} · IBGE {farm.municipalityIbge}
                        </Text>
                      </div>
                      <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setDialog({ kind: "plot", farm })}>
                        Novo talhão
                      </Button>
                    </Group>
                    {farmPlots.length === 0 ? (
                      <Empty>Nenhum talhão.</Empty>
                    ) : (
                      <Table verticalSpacing="xs">
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Talhão</Table.Th>
                            <Table.Th>Área</Table.Th>
                            <Table.Th>CAR</Table.Th>
                            <Table.Th>Solo</Table.Th>
                            <Table.Th>Ciclos</Table.Th>
                            <Table.Th />
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {farmPlots.map((p) => (
                            <Table.Tr key={p.id}>
                              <Table.Td>
                                <Link to="/talhoes/$plotId" params={{ plotId: p.id }}>
                                  {p.name}
                                </Link>
                              </Table.Td>
                              <Table.Td>{fmtHa(p.areaM2)}</Table.Td>
                              <Table.Td>
                                <Text size="xs">{p.carCode ?? "—"}</Text>
                              </Table.Td>
                              <Table.Td>{p.hasSoilAnalysis ? <Badge variant="light">{fmtDate(p.latestSoilAnalysisOn)}</Badge> : <Text size="xs" c="dimmed">sem análise</Text>}</Table.Td>
                              <Table.Td>
                                <Group gap={4}>
                                  {cycles
                                    .filter((c) => c.plotId === p.id)
                                    .map((c) => (
                                      <Badge key={c.id} variant="outline" style={{ cursor: "pointer" }} onClick={() => navigate({ to: "/ciclos/$cycleId", params: { cycleId: c.id } })}>
                                        {CROP_LABEL[c.crop]} {c.seasonCode}
                                      </Badge>
                                    ))}
                                </Group>
                              </Table.Td>
                              <Table.Td ta="right">
                                <Button size="xs" variant="subtle" onClick={() => setDialog({ kind: "cycle", plot: p })}>
                                  Novo ciclo
                                </Button>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    )}
                  </Card>
                );
              })}
            </Stack>
          )
        }
      </QueryGate>

      {dialog?.kind === "farm" && <FarmForm opened onClose={close} />}
      {dialog?.kind === "plot" && <PlotForm farm={dialog.farm} opened onClose={close} />}
      {dialog?.kind === "cycle" && <NewCycleForm plot={dialog.plot} opened onClose={close} />}
    </>
  );
}

/** Phone-first: pick the cycle, then the truck form opens straight away. */
export function DispatchPage() {
  const cycles = (useCycles().data ?? []).filter((c) => (c.cpr.status === "ISSUED" || c.cpr.status === "FUNDED") && ["HARVESTING", "DELIVERING", "DELIVERED"].includes(c.stage));
  const plots = usePlots().data ?? [];
  const [cycleId, setCycleId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const cycle = cycles.find((c) => c.id === cycleId);
  return (
    <>
      <PageHeader title="Despachar caminhão" subtitle="Para ciclos em colheita, com CPR emitida" />
      <Card withBorder maw={520}>
        <Stack>
          {cycles.length === 0 ? (
            <Empty>Nenhum ciclo em colheita com CPR. Registre o início da colheita no ciclo.</Empty>
          ) : (
            <>
              <Select
                size="lg"
                label="Ciclo"
                data={cycles.map((c) => ({ value: c.id, label: `${plots.find((p) => p.id === c.plotId)?.name ?? "Talhão"} — ${CROP_LABEL[c.crop]} ${c.seasonCode}` }))}
                value={cycleId}
                onChange={setCycleId}
              />
              <Button size="lg" leftSection={<IconTruckDelivery />} disabled={!cycle} onClick={() => setOpen(true)}>
                Novo caminhão
              </Button>
            </>
          )}
        </Stack>
      </Card>
      {cycle && open && <DispatchForm cycle={cycle} opened onClose={() => setOpen(false)} />}
    </>
  );
}

export function PlotDetailPage() {
  const { plotId } = useParams({ strict: false }) as { plotId: string };
  const me = useActor();
  const plot = usePlot(plotId);
  const timeline = usePlotTimeline(plotId);
  const cycles = (useCycles().data ?? []).filter((c) => c.plotId === plotId);
  const farms = useFarms().data ?? [];
  const [dialog, setDialog] = useState<"soil" | "cycle" | null>(null);
  const soil = (timeline.data ?? []).filter((e) => e.eventType === "SOIL_ANALYSIS_ATTACHED" && !e.voided);
  const canEdit = me.role === "PRODUCER" || me.role === "ADMIN";

  return (
    <QueryGate query={plot}>
      {(p) => (
        <>
          <PageHeader
            title={p.name}
            subtitle={`${farms.find((f) => f.id === p.farmId)?.name ?? ""} · ${p.uf} · IBGE ${p.municipalityIbge}`}
            actions={
              canEdit && (
                <>
                  <Button variant="light" onClick={() => setDialog("soil")}>
                    Anexar análise de solo
                  </Button>
                  <Button onClick={() => setDialog("cycle")}>Novo ciclo</Button>
                </>
              )
            }
          />
          <SimpleGrid cols={{ base: 2, sm: 4 }} mb="lg">
            <StatCard label="Área" value={fmtHa(p.areaM2)} />
            <StatCard label="CAR" value={<Text size="sm">{p.carCode ?? "—"}</Text>} />
            <StatCard label="Análises de solo" value={soil.length} hint={p.latestSoilAnalysisOn ? `última coleta ${fmtDate(p.latestSoilAnalysisOn)}` : undefined} />
            <StatCard label="Ciclos" value={cycles.length} />
          </SimpleGrid>
          <Grid gutter="lg">
            <Grid.Col span={{ base: 12, md: 7 }}>
              <Card withBorder mb="lg">
                <Title order={4} mb="sm">
                  Ciclos neste talhão
                </Title>
                <CyclesTable cycles={cycles} />
              </Card>
              <Card withBorder>
                <Title order={4} mb="sm">
                  Análises de solo
                </Title>
                {soil.length === 0 ? (
                  <Empty>Nenhuma análise. Anexe o laudo ou use a referência do gêmeo digital.</Empty>
                ) : (
                  <Table>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Coleta</Table.Th>
                        <Table.Th>Laboratório</Table.Th>
                        <Table.Th>pH</Table.Th>
                        <Table.Th>MO (%)</Table.Th>
                        <Table.Th>Argila (%)</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {soil.map((e) => {
                        const s = e.payload as Record<string, any>;
                        return (
                          <Table.Tr key={e.id}>
                            <Table.Td>{fmtDate(s.sampledOn)}</Table.Td>
                            <Table.Td>{s.labName}</Table.Td>
                            <Table.Td>{s.ph ?? "—"}</Table.Td>
                            <Table.Td>{s.organicMatterPct ?? "—"}</Table.Td>
                            <Table.Td>{s.clayPct ?? "—"}</Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                )}
              </Card>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 5 }}>
              <Card withBorder>
                <Title order={4} mb="sm">
                  Histórico do talhão
                </Title>
                <QueryGate query={timeline}>{(events) => <EventTimeline events={events} />}</QueryGate>
              </Card>
            </Grid.Col>
          </Grid>
          {dialog === "soil" && <SoilAnalysisForm plot={p} opened onClose={() => setDialog(null)} />}
          {dialog === "cycle" && <NewCycleForm plot={p} opened onClose={() => setDialog(null)} />}
        </>
      )}
    </QueryGate>
  );
}
