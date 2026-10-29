import { Group, Progress, ScrollArea, Table, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useFarms, usePlots } from "../api/queries";
import type { CropCycle } from "../api/types";
import { fmtPct, fmtTons } from "../lib/format";
import { CROP_LABEL } from "../lib/labels";
import { CprBadge, Empty, RiskBadge, StageBadge } from "./common";

export function usePlotNames() {
  const plots = usePlots().data ?? [];
  const farms = useFarms().data ?? [];
  return (plotId: string) => {
    const p = plots.find((x) => x.id === plotId);
    if (!p) return "Talhão";
    const f = farms.find((x) => x.id === p.farmId);
    return f ? `${f.name} / ${p.name}` : p.name;
  };
}

export function CyclesTable({ cycles }: { cycles: CropCycle[] }) {
  const navigate = useNavigate();
  const plotName = usePlotNames();
  if (!cycles.length) return <Empty>Nenhum ciclo para mostrar.</Empty>;
  return (
    <ScrollArea>
      <Table highlightOnHover verticalSpacing="sm" miw={760}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Talhão</Table.Th>
            <Table.Th>Cultura e safra</Table.Th>
            <Table.Th>Etapa</Table.Th>
            <Table.Th>CPR</Table.Th>
            <Table.Th>Entregue</Table.Th>
            <Table.Th>Risco</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {cycles.map((c) => (
            <Table.Tr key={c.id} style={{ cursor: "pointer" }} onClick={() => navigate({ to: "/ciclos/$cycleId", params: { cycleId: c.id } })}>
              <Table.Td>
                <Text fw={500}>{plotName(c.plotId)}</Text>
              </Table.Td>
              <Table.Td>
                {CROP_LABEL[c.crop]} {c.seasonCode}
              </Table.Td>
              <Table.Td>
                <StageBadge stage={c.stage} />
              </Table.Td>
              <Table.Td>
                <Group gap={6}>
                  <CprBadge status={c.cpr.status} />
                  {c.cpr.issuedKg ? <Text size="xs">{fmtTons(c.cpr.issuedKg)}</Text> : null}
                </Group>
              </Table.Td>
              <Table.Td miw={140}>
                {c.cpr.issuedKg ? (
                  <>
                    <Text size="xs">{fmtPct(c.fulfillment.fulfilledBps)}</Text>
                    <Progress value={Math.min(100, c.fulfillment.fulfilledBps / 100)} size="sm" color={c.fulfillment.fulfilledBps >= 9_800 ? "teal" : "blue"} />
                  </>
                ) : (
                  <Text size="xs" c="dimmed">
                    —
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <RiskBadge grade={c.risk.grade} score={c.risk.score} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}
