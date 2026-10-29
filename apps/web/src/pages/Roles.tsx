import { Badge, Button, Card, Group, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { IconTruck } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useActor, useArrivals, useCprRequests, useCycles, usePortfolio } from "../api/queries";
import type { CprRequest, CropCycle } from "../api/types";
import { Empty, OrgSelect, PageHeader, QueryGate, RiskBadge, StatCard } from "../components/common";
import { CyclesTable, usePlotNames } from "../components/CyclesTable";
import { ApproveCprForm, RejectCprForm } from "../components/forms/financier";
import { ClaimSettleForm } from "../components/forms/insurance";
import { ArrivalForm, ReceiptForm, type TruckRef } from "../components/forms/warehouse";
import { fmtBrl, fmtDate, fmtDateTime, fmtKg, fmtTons } from "../lib/format";
import { CAUSE_LABEL, COVERAGE_LABEL, CROP_LABEL, GRADE_COLOR } from "../lib/labels";

// ---------- financier ----------

export function PortfolioPage() {
  const portfolio = usePortfolio();
  const cycles = useCycles().data ?? [];
  const pending = useCprRequests("PENDING");
  const plotName = usePlotNames();
  const [dialog, setDialog] = useState<{ kind: "approve" | "reject"; request: CprRequest } | null>(null);
  const withCpr = cycles.filter((c) => c.cpr.status !== "NONE");

  return (
    <>
      <PageHeader title="Carteira de CPRs" subtitle="Volume contratado, entregas e risco dos ciclos que você financia" />
      <QueryGate query={portfolio}>
        {(p) => (
          <SimpleGrid cols={{ base: 2, md: 5 }} mb="lg">
            <StatCard label="CPRs" value={p.cprCount} />
            <StatCard label="Volume contratado" value={fmtTons(p.issuedKg)} />
            <StatCard label="Entregue" value={fmtTons(p.deliveredNetKg)} hint={p.issuedKg ? `${Math.round((p.deliveredNetKg / p.issuedKg) * 100)}% do contratado` : undefined} />
            <StatCard label="Desembolsado" value={fmtBrl(p.fundedBrlCents)} />
            <StatCard
              label="Risco"
              value={
                <Group gap={6}>
                  {(["A", "B", "C", "D"] as const).map((g) => (
                    <Badge key={g} color={GRADE_COLOR[g]} variant={p.byGrade[g] ? "filled" : "light"}>
                      {g}: {p.byGrade[g] ?? 0}
                    </Badge>
                  ))}
                </Group>
              }
              hint={`${p.openHighAlerts} alertas altos abertos`}
            />
          </SimpleGrid>
        )}
      </QueryGate>

      <Card withBorder mb="lg">
        <Title order={4} mb="sm">
          Pedidos de CPR aguardando decisão
        </Title>
        <QueryGate query={pending}>
          {(items) =>
            items.length === 0 ? (
              <Empty>Nenhum pedido pendente.</Empty>
            ) : (
              <Table verticalSpacing="sm">
                <Table.Tbody>
                  {items.map((r) => {
                    const cycle = cycles.find((c) => c.id === r.cropCycleId);
                    return (
                      <Table.Tr key={r.id}>
                        <Table.Td>
                          <Link to="/ciclos/$cycleId" params={{ cycleId: r.cropCycleId }}>
                            {cycle ? `${plotName(cycle.plotId)} — ${CROP_LABEL[cycle.crop]} ${cycle.seasonCode}` : "Ciclo"}
                          </Link>
                          <Text size="xs" c="dimmed">
                            {fmtKg(r.requestedKg)} pedidos{cycle && ` · elegível ${fmtKg(cycle.eligibleKg)}`} · vencimento {fmtDate(r.dueDate)}
                          </Text>
                        </Table.Td>
                        <Table.Td>{cycle && <RiskBadge grade={cycle.risk.grade} score={cycle.risk.score} />}</Table.Td>
                        <Table.Td ta="right">
                          <Group gap="xs" justify="flex-end">
                            <Button size="xs" onClick={() => setDialog({ kind: "approve", request: r })}>
                              Aprovar
                            </Button>
                            <Button size="xs" variant="default" onClick={() => setDialog({ kind: "reject", request: r })}>
                              Recusar
                            </Button>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            )
          }
        </QueryGate>
      </Card>

      <Card withBorder>
        <Title order={4} mb="sm">
          Ciclos com CPR
        </Title>
        <CyclesTable cycles={withCpr} />
      </Card>

      {dialog?.kind === "approve" && <ApproveCprForm request={dialog.request} cycle={cycles.find((c) => c.id === dialog.request.cropCycleId)} opened onClose={() => setDialog(null)} />}
      {dialog?.kind === "reject" && <RejectCprForm request={dialog.request} opened onClose={() => setDialog(null)} />}
    </>
  );
}

// ---------- warehouse ----------

/** Phone-first: one card per expected truck, with the next step as a big button. */
export function ArrivalsPage() {
  const me = useActor();
  const [warehouseId, setWarehouseId] = useState<string | null>(me.role === "WAREHOUSE" ? me.orgId : null);
  const arrivals = useArrivals(warehouseId);
  const cycles = useCycles().data ?? [];
  const [dialog, setDialog] = useState<{ kind: "arrival" | "receipt"; truck: TruckRef } | null>(null);

  return (
    <>
      <PageHeader title="Chegadas e classificação" subtitle="Caminhões despachados para o armazém e ainda não recebidos" />
      {me.role === "ADMIN" && (
        <Card withBorder mb="md" maw={420}>
          <OrgSelect kind="WAREHOUSE" label="Armazém" value={warehouseId} onChange={setWarehouseId} />
        </Card>
      )}
      {warehouseId && (
        <QueryGate query={arrivals}>
          {(items) =>
            items.length === 0 ? (
              <Empty>Nenhum caminhão a caminho.</Empty>
            ) : (
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
                {items.map((a) => {
                  const cycle = cycles.find((c) => c.id === a.cropCycleId);
                  const truck: TruckRef = { cycleId: a.cropCycleId, crop: cycle?.crop ?? "SOJA", deliveryId: a.deliveryId, truckPlate: a.truckPlate, estimatedKg: a.estimatedKg };
                  return (
                    <Card withBorder key={a.deliveryId} padding="lg">
                      <Group justify="space-between" mb="xs">
                        <Group gap="xs">
                          <IconTruck />
                          <Text fw={700} size="xl" ff="monospace">
                            {a.truckPlate}
                          </Text>
                        </Group>
                        <Badge color={a.arrived ? "teal" : "blue"}>{a.arrived ? "No pátio" : "A caminho"}</Badge>
                      </Group>
                      <Text size="sm">{a.producerName}</Text>
                      <Text size="sm" c="dimmed">
                        {cycle ? `${CROP_LABEL[cycle.crop]} ${cycle.seasonCode} · ` : ""}
                        {fmtKg(a.estimatedKg)} estimados
                      </Text>
                      <Text size="sm" c="dimmed" mb="md">
                        Previsto {fmtDateTime(a.expectedArrivalAt)}
                      </Text>
                      <Button size="lg" fullWidth variant={a.arrived ? "filled" : "light"} onClick={() => setDialog({ kind: a.arrived ? "receipt" : "arrival", truck })}>
                        {a.arrived ? "Classificar e receber" : "Registrar chegada"}
                      </Button>
                    </Card>
                  );
                })}
              </SimpleGrid>
            )
          }
        </QueryGate>
      )}
      {dialog?.kind === "arrival" && <ArrivalForm truck={dialog.truck} opened onClose={() => setDialog(null)} />}
      {dialog?.kind === "receipt" && <ReceiptForm truck={dialog.truck} opened onClose={() => setDialog(null)} />}
    </>
  );
}

// ---------- insurer ----------

export function InsurerPage() {
  const me = useActor();
  const cycles = useCycles();
  const plotName = usePlotNames();
  const [settle, setSettle] = useState<{ cycle: CropCycle; claimId: string } | null>(null);

  return (
    <>
      <PageHeader title="Apólices e sinistros" subtitle="Ciclos em que o produtor vinculou a sua seguradora" />
      <QueryGate query={cycles}>
        {(items) => {
          const openClaims = items.flatMap((c) => c.insurance.claims.filter((cl) => !cl.settlement && (me.role === "ADMIN" || cl.insurerOrgId === me.orgId)).map((cl) => ({ cycle: c, claim: cl })));
          const uninsured = items.filter((c) => c.insurance.policies.length === 0);
          return (
            <Stack>
              <SimpleGrid cols={{ base: 2, md: 4 }}>
                <StatCard label="Ciclos vinculados" value={items.length} />
                <StatCard label="Apólices" value={items.reduce((s, c) => s + c.insurance.policies.length, 0)} />
                <StatCard label="Sinistros abertos" value={openClaims.length} />
                <StatCard label="Aguardando apólice" value={uninsured.length} />
              </SimpleGrid>

              <Card withBorder>
                <Title order={4} mb="sm">
                  Sinistros abertos
                </Title>
                {openClaims.length === 0 ? (
                  <Empty>Nenhum sinistro aberto.</Empty>
                ) : (
                  <Table verticalSpacing="sm">
                    <Table.Tbody>
                      {openClaims.map(({ cycle, claim }) => (
                        <Table.Tr key={claim.claimId}>
                          <Table.Td>
                            <Link to="/ciclos/$cycleId" params={{ cycleId: cycle.id }}>
                              {plotName(cycle.plotId)} — {CROP_LABEL[cycle.crop]} {cycle.seasonCode}
                            </Link>
                            <Text size="xs" c="dimmed">
                              Apólice {claim.policyNumber} · {CAUSE_LABEL[claim.cause!] ?? claim.cause} em {fmtDate(claim.lossOn)} · perda estimada {fmtKg(claim.estimatedLossKg)} · comunicado {fmtDateTime(claim.filedAt)}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <RiskBadge grade={cycle.risk.grade} score={cycle.risk.score} />
                          </Table.Td>
                          <Table.Td ta="right">
                            <Button size="xs" onClick={() => setSettle({ cycle, claimId: claim.claimId! })}>
                              Regular
                            </Button>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </Card>

              <Card withBorder>
                <Title order={4} mb="sm">
                  Apólices
                </Title>
                {items.every((c) => c.insurance.policies.length === 0) ? (
                  <Empty>Nenhuma apólice ainda. Abra um ciclo para emitir.</Empty>
                ) : (
                  <Table>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Ciclo</Table.Th>
                        <Table.Th>Apólice</Table.Th>
                        <Table.Th>Segurado</Table.Th>
                        <Table.Th>Vigência</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {items.flatMap((c) =>
                        c.insurance.policies.map((p) => (
                          <Table.Tr key={p.policyNumber}>
                            <Table.Td>
                              <Link to="/ciclos/$cycleId" params={{ cycleId: c.id }}>
                                {plotName(c.plotId)}
                              </Link>
                            </Table.Td>
                            <Table.Td>
                              {p.policyNumber} ({COVERAGE_LABEL[p.coverage!]})
                            </Table.Td>
                            <Table.Td>{fmtBrl(p.insuredBrlCents)}</Table.Td>
                            <Table.Td>
                              {fmtDate(p.startsOn)} a {fmtDate(p.endsOn)}
                            </Table.Td>
                          </Table.Tr>
                        )),
                      )}
                    </Table.Tbody>
                  </Table>
                )}
              </Card>

              <Card withBorder>
                <Title order={4} mb="sm">
                  Todos os ciclos vinculados
                </Title>
                <CyclesTable cycles={items} />
              </Card>
            </Stack>
          );
        }}
      </QueryGate>
      {settle && (() => {
        const claim = settle.cycle.insurance.claims.find((c) => c.claimId === settle.claimId);
        return claim ? <ClaimSettleForm cycle={settle.cycle} claim={claim} opened onClose={() => setSettle(null)} /> : null;
      })()}
    </>
  );
}
