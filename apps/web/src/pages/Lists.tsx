import { Button, Card, Group, SegmentedControl, Select, Stack, Table, Text } from "@mantine/core";
import { Link, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { api, unwrap } from "../api/client";
import { useActor, useAlerts, useCycles, useWrite } from "../api/queries";
import { PageHeader, QueryGate, SeverityBadge } from "../components/common";
import { CyclesTable } from "../components/CyclesTable";
import { HOME } from "../components/Layout";
import { notifyError } from "../lib/events";
import { fmtDateTime } from "../lib/format";
import { ALERT_LABEL, options, STAGE_LABEL } from "../lib/labels";

export function HomeRedirect() {
  const me = useActor();
  return <Navigate to={HOME[me.role]} />;
}

export function CyclesPage() {
  const me = useActor();
  const cycles = useCycles();
  const [grade, setGrade] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="Ciclos"
        subtitle={me.role === "BUYER" ? "Ciclos com grão liberado ou vendido para você" : "Talhão + cultura + safra; cada um pode ter uma CPR"}
        actions={
          <>
            <Select placeholder="Etapa" clearable data={options(STAGE_LABEL)} value={stage} onChange={setStage} w={180} />
            <Select placeholder="Risco" clearable data={["A", "B", "C", "D"]} value={grade} onChange={setGrade} w={110} />
          </>
        }
      />
      <Card withBorder>
        <QueryGate query={cycles}>{(items) => <CyclesTable cycles={items.filter((c) => (!grade || c.risk.grade === grade) && (!stage || c.stage === stage))} />}</QueryGate>
      </Card>
    </>
  );
}

export function AlertsPage() {
  const [which, setWhich] = useState("open");
  const alerts = useAlerts({ open: which === "open" });
  const ack = useWrite((alertId: string) => unwrap(api.POST("/v1/alerts/{alertId}/ack", { params: { path: { alertId } } })));
  return (
    <>
      <PageHeader
        title="Alertas"
        subtitle="Gerados pelas regras a cada registro; somem quando a condição deixa de existir"
        actions={<SegmentedControl value={which} onChange={setWhich} data={[{ value: "open", label: "Abertos" }, { value: "all", label: "Todos" }]} />}
      />
      <Card withBorder>
        <QueryGate query={alerts}>
          {(items) =>
            items.length === 0 ? (
              <Text c="dimmed" ta="center" py="lg">
                Nenhum alerta.
              </Text>
            ) : (
              <Table verticalSpacing="sm">
                <Table.Tbody>
                  {items.map((a) => (
                    <Table.Tr key={a.id} opacity={a.resolvedAt ? 0.55 : 1}>
                      <Table.Td w={90}>
                        <SeverityBadge severity={a.severity} />
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={2}>
                          <Text fw={600} size="sm">
                            {ALERT_LABEL[a.type] ?? a.type}
                            {a.resolvedAt && " (resolvido)"}
                          </Text>
                          <Text size="sm">{a.message}</Text>
                          <Text size="xs" c="dimmed">
                            {fmtDateTime(a.createdAt)}
                            {a.ackedAt && ` · ciente em ${fmtDateTime(a.ackedAt)}`}
                          </Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Group gap="xs" justify="flex-end" wrap="nowrap">
                          {a.cropCycleId && (
                            <Link to="/ciclos/$cycleId" params={{ cycleId: a.cropCycleId }}>
                              <Button size="xs" variant="default">
                                Ver ciclo
                              </Button>
                            </Link>
                          )}
                          {!a.ackedAt && !a.resolvedAt && (
                            <Button size="xs" variant="light" loading={ack.isPending && ack.variables === a.id} onClick={() => ack.mutate(a.id, { onError: notifyError })}>
                              Ciente
                            </Button>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )
          }
        </QueryGate>
      </Card>
    </>
  );
}
