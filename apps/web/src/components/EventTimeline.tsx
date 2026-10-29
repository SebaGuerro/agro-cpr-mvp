import { ActionIcon, Badge, Group, Menu, Paper, Stack, Text, Timeline } from "@mantine/core";
import { IconDots, IconFileImport, IconPencil, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useActor, useOrgs } from "../api/queries";
import type { EventRecord } from "../api/types";
import { fmtDateTime } from "../lib/format";
import { EVENT_LABEL, ROLE_LABEL } from "../lib/labels";
import { eventSummary } from "../lib/summary";
import { AnchorBadge, Empty } from "./common";
import { CorrectionForm, VoidForm } from "./forms/correction";

const NOT_CORRECTABLE = new Set(["EVENT_CORRECTED", "EVENT_VOIDED"]);

/** Every event in the order it happened, with corrections and voids linked and the on-chain status. */
export function EventTimeline({ events }: { events: EventRecord[] }) {
  const me = useActor();
  const orgs = useOrgs().data ?? [];
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? ROLE_LABEL.ADMIN;
  const [dialog, setDialog] = useState<{ kind: "correct" | "void"; event: EventRecord } | null>(null);
  const byId = new Map(events.map((e) => [e.id, e]));

  if (!events.length) return <Empty>Nenhum registro ainda.</Empty>;
  return (
    <>
      <Timeline bulletSize={14} lineWidth={2} active={events.length}>
        {events.map((e) => {
          const canCorrect = !NOT_CORRECTABLE.has(e.eventType) && !e.voided && (me.role === "ADMIN" || me.orgId === e.actorOrgId) && e.eventType !== "CPR_SETTLED";
          const canVoid = me.role === "ADMIN" && !NOT_CORRECTABLE.has(e.eventType) && !e.voided && e.eventType !== "CPR_ISSUED" && e.eventType !== "CPR_SETTLED";
          const target = e.refEventId ? byId.get(e.refEventId) : null;
          return (
            <Timeline.Item
              key={e.id}
              color={e.voided ? "gray" : e.eventType === "EVENT_CORRECTED" ? "orange" : e.eventType === "EVENT_VOIDED" ? "red" : "green"}
              title={
                <Group gap="xs" justify="space-between" wrap="nowrap">
                  <Group gap="xs">
                    <Text fw={600} td={e.voided ? "line-through" : undefined}>
                      {EVENT_LABEL[e.eventType] ?? e.eventType}
                    </Text>
                    {e.voided && <Badge color="gray">Anulado</Badge>}
                    {e.correctedBy.length > 0 && <Badge color="orange" variant="light">Corrigido</Badge>}
                    {e.provenance === "IMPORTED" && (
                      <Badge variant="outline" leftSection={<IconFileImport size={12} />}>
                        Importado
                      </Badge>
                    )}
                  </Group>
                  {(canCorrect || canVoid) && (
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon variant="subtle" color="gray" aria-label="Ações">
                          <IconDots size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {canCorrect && (
                          <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setDialog({ kind: "correct", event: e })}>
                            Corrigir
                          </Menu.Item>
                        )}
                        {canVoid && (
                          <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setDialog({ kind: "void", event: e })}>
                            Anular
                          </Menu.Item>
                        )}
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </Group>
              }
            >
              <Paper p={0} bg="transparent">
                <Stack gap={2}>
                  <Text size="sm">{eventSummary(e)}</Text>
                  {target && (
                    <Text size="xs" c="dimmed">
                      Sobre: {EVENT_LABEL[target.eventType]} de {fmtDateTime(target.occurredAt)}
                    </Text>
                  )}
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      {fmtDateTime(e.occurredAt)} · {orgName(e.actorOrgId)} ({ROLE_LABEL[e.actorRole]})
                    </Text>
                    <AnchorBadge anchor={e.anchor} />
                  </Group>
                </Stack>
              </Paper>
            </Timeline.Item>
          );
        })}
      </Timeline>
      {dialog?.kind === "correct" && <CorrectionForm event={dialog.event} opened onClose={() => setDialog(null)} />}
      {dialog?.kind === "void" && <VoidForm event={dialog.event} opened onClose={() => setDialog(null)} />}
    </>
  );
}
