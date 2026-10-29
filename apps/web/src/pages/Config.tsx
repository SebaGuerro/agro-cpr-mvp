import { ActionIcon, Alert, Button, Card, Checkbox, Group, NumberInput, ScrollArea, Select, Stack, Table, Tabs, Text, TextInput, Title } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { v7 as uuidv7 } from "uuid";
import { api, unwrap } from "../api/client";
import { useConfig, useWrite } from "../api/queries";
import type { ChecklistTemplate, DiscountTable, Haircut, PlantingWindow } from "../api/types";
import { DecimalInput, PageHeader } from "../components/common";
import { notifyError, notifySaved } from "../lib/events";
import { CATEGORY_LABEL, CROP_LABEL, CROPS, options } from "../lib/labels";

const num = { decimalSeparator: ",", thousandSeparator: ".", size: "xs" } as const;
const cropOptions = options(CROP_LABEL, CROPS);

interface Column<T> {
  header: string;
  width?: number;
  cell(row: T, set: (patch: Partial<T>) => void): ReactNode;
}

/** A table whose rows are edited in place, saved together with one PUT. */
function RowsEditor<T>({ initial, columns, blank, onSave, note }: { initial: T[]; columns: Column<T>[]; blank(): T; onSave(rows: T[]): Promise<unknown>; note?: ReactNode }) {
  const [rows, setRows] = useState<T[]>(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setRows(initial), [initial]);
  return (
    <Stack>
      {note}
      <ScrollArea>
        <Table miw={720}>
          <Table.Thead>
            <Table.Tr>
              {columns.map((c) => (
                <Table.Th key={c.header} w={c.width}>
                  {c.header}
                </Table.Th>
              ))}
              <Table.Th w={40} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row, i) => (
              <Table.Tr key={i}>
                {columns.map((c) => (
                  <Table.Td key={c.header}>{c.cell(row, (patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))))}</Table.Td>
                ))}
                <Table.Td>
                  <ActionIcon variant="subtle" color="red" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label="Remover">
                    <IconTrash size={16} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      <Group>
        <Button variant="default" leftSection={<IconPlus size={14} />} onClick={() => setRows((rs) => [...rs, blank()])}>
          Adicionar linha
        </Button>
        <Button
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(rows);
              notifySaved("Configuração salva; os alertas e notas de risco foram recalculados");
            } catch (err) {
              notifyError(err);
            } finally {
              setSaving(false);
            }
          }}
        >
          Salvar
        </Button>
      </Group>
    </Stack>
  );
}

const toDdMm = (md: string) => (md ? `${md.slice(3, 5)}/${md.slice(0, 2)}` : "");
const fromDdMm = (s: string) => {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(s.trim());
  return m ? `${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : s;
};

export function ConfigPage() {
  const cfg = useConfig();
  const put = useWrite(async ({ path, body }: { path: "planting-windows" | "haircuts" | "discount-tables" | "checklists"; body: unknown }) =>
    unwrap(api.PUT(`/v1/config/${path}` as "/v1/config/haircuts", { body: body as never })),
  );
  const save = (path: Parameters<typeof put.mutateAsync>[0]["path"]) => (rows: unknown[]) => put.mutateAsync({ path, body: rows });

  return (
    <>
      <PageHeader title="Configurações" subtitle="Regras usadas no cálculo do volume elegível, nos alertas e na nota de risco" />
      <Tabs defaultValue="haircuts" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="haircuts">Haircut</Tabs.Tab>
          <Tabs.Tab value="windows">Janelas de plantio</Tabs.Tab>
          <Tabs.Tab value="discounts">Tabelas de desconto</Tabs.Tab>
          <Tabs.Tab value="checklists">Checklist de insumos</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="haircuts">
          <Card withBorder>
            <RowsEditor<Haircut>
              initial={cfg.haircuts}
              blank={() => ({ crop: "SOJA", haircutBps: 8_000 })}
              onSave={save("haircuts")}
              note={<Text size="sm">Percentual do potencial que pode ir para a CPR. Ex.: 80% de um potencial de 1.000 t permite uma CPR de até 800 t. Sem linha para a cultura, vale 80%.</Text>}
              columns={[
                { header: "Cultura", cell: (r, set) => <Select size="xs" data={cropOptions} value={r.crop} onChange={(v) => v && set({ crop: v as Haircut["crop"] })} /> },
                { header: "Elegível (%)", cell: (r, set) => <DecimalInput size="xs" max={100} value={r.haircutBps / 100} onChange={(v) => set({ haircutBps: Math.round(Number(v || 0) * 100) })} /> },
              ]}
            />
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="windows">
          <Card withBorder>
            <RowsEditor<PlantingWindow>
              initial={cfg.windows}
              blank={() => ({ crop: "SOJA", season: "SAFRA", uf: "", municipalityIbge: null, startMonthDay: "", endMonthDay: "", source: "", isSample: false })}
              onSave={(rows) => save("planting-windows")(rows.map(({ id: _id, ...w }) => w))}
              note={
                cfg.windows.some((w) => w.isSample) && (
                  <Alert color="yellow">Há janelas marcadas como amostra. Substitua pelos dados oficiais do ZARC antes do uso real (ou importe a planilha do ZARC).</Alert>
                )
              }
              columns={[
                { header: "Cultura", width: 120, cell: (r, set) => <Select size="xs" data={cropOptions} value={r.crop} onChange={(v) => v && set({ crop: v as PlantingWindow["crop"] })} /> },
                { header: "Safra", width: 120, cell: (r, set) => <Select size="xs" data={["SAFRA", "SAFRINHA", "UNICA"]} value={r.season} onChange={(v) => v && set({ season: v as PlantingWindow["season"] })} /> },
                { header: "UF", width: 70, cell: (r, set) => <TextInput size="xs" maxLength={2} value={r.uf} onChange={(e) => set({ uf: e.currentTarget.value.toUpperCase() })} /> },
                { header: "Município (IBGE)", width: 120, cell: (r, set) => <TextInput size="xs" placeholder="UF inteira" value={r.municipalityIbge ?? ""} onChange={(e) => set({ municipalityIbge: e.currentTarget.value || null })} /> },
                { header: "Início (dd/mm)", width: 100, cell: (r, set) => <TextInput size="xs" defaultValue={toDdMm(r.startMonthDay)} onBlur={(e) => set({ startMonthDay: fromDdMm(e.currentTarget.value) })} /> },
                { header: "Fim (dd/mm)", width: 100, cell: (r, set) => <TextInput size="xs" defaultValue={toDdMm(r.endMonthDay)} onBlur={(e) => set({ endMonthDay: fromDdMm(e.currentTarget.value) })} /> },
                { header: "Fonte", cell: (r, set) => <TextInput size="xs" value={r.source} onChange={(e) => set({ source: e.currentTarget.value })} /> },
                { header: "Amostra", width: 70, cell: (r, set) => <Checkbox checked={r.isSample} onChange={(e) => set({ isSample: e.currentTarget.checked })} /> },
              ]}
            />
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="discounts">
          <Card withBorder>
            <RowsEditor<DiscountTable>
              initial={cfg.discounts}
              blank={() => ({ crop: "SOJA", moistureBasePct: 14, moistureDiscountPerPointPct: 1.5, impurityBasePct: 1, impurityDiscountPerPointPct: 1, damagedBasePct: null, damagedDiscountPerPointPct: null, isSample: false })}
              onSave={save("discount-tables")}
              note={<Text size="sm">Cada ponto acima da base desconta o percentual indicado do peso bruto. O sistema compara com o ticket do armazém e alerta se divergir.</Text>}
              columns={[
                { header: "Cultura", width: 120, cell: (r, set) => <Select size="xs" data={cropOptions} value={r.crop} onChange={(v) => v && set({ crop: v as DiscountTable["crop"] })} /> },
                { header: "Umidade base", cell: (r, set) => <DecimalInput size="xs" value={r.moistureBasePct} onChange={(v) => set({ moistureBasePct: v === "" ? 0 : v })} /> },
                { header: "% por ponto", cell: (r, set) => <DecimalInput size="xs" value={r.moistureDiscountPerPointPct} onChange={(v) => set({ moistureDiscountPerPointPct: v === "" ? 0 : v })} /> },
                { header: "Impureza base", cell: (r, set) => <DecimalInput size="xs" value={r.impurityBasePct} onChange={(v) => set({ impurityBasePct: v === "" ? 0 : v })} /> },
                { header: "% por ponto", cell: (r, set) => <DecimalInput size="xs" value={r.impurityDiscountPerPointPct} onChange={(v) => set({ impurityDiscountPerPointPct: v === "" ? 0 : v })} /> },
                { header: "Avariados base", cell: (r, set) => <DecimalInput size="xs" value={r.damagedBasePct ?? ""} onChange={(v) => set({ damagedBasePct: v === "" ? null : v })} /> },
                { header: "% por ponto", cell: (r, set) => <DecimalInput size="xs" value={r.damagedDiscountPerPointPct ?? ""} onChange={(v) => set({ damagedDiscountPerPointPct: v === "" ? null : v })} /> },
                { header: "Amostra", width: 70, cell: (r, set) => <Checkbox checked={r.isSample} onChange={(e) => set({ isSample: e.currentTarget.checked })} /> },
              ]}
            />
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="checklists">
          <ChecklistsEditor templates={cfg.checklists} onSave={save("checklists")} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

type Item = ChecklistTemplate["items"][number];

function ChecklistsEditor({ templates, onSave }: { templates: ChecklistTemplate[]; onSave(rows: ChecklistTemplate[]): Promise<unknown> }) {
  const [crop, setCrop] = useState<string>("SOJA");
  const template = templates.find((t) => t.crop === crop);
  return (
    <Card withBorder>
      <Group mb="md">
        <Select label="Cultura" data={cropOptions} value={crop} onChange={(v) => v && setCrop(v)} allowDeselect={false} w={200} />
      </Group>
      <Title order={5} mb="xs">
        Aplicações esperadas, em dias a partir do início do plantio (negativo = antes)
      </Title>
      <RowsEditor<Item>
        key={crop}
        initial={template?.items ?? []}
        blank={() => ({ id: uuidv7(), category: "FUNGICIDE", description: "", fromDay: 0, toDay: 0 })}
        onSave={(items) => {
          const others = templates.filter((t) => t.crop !== crop);
          const next = items.length ? [...others, { id: template?.id ?? uuidv7(), crop: crop as ChecklistTemplate["crop"], items }] : others;
          return onSave(next);
        }}
        columns={[
          { header: "Categoria", width: 180, cell: (r, set) => <Select size="xs" data={options(CATEGORY_LABEL)} value={r.category} onChange={(v) => v && set({ category: v as Item["category"] })} /> },
          { header: "Descrição", cell: (r, set) => <TextInput size="xs" value={r.description} onChange={(e) => set({ description: e.currentTarget.value })} /> },
          { header: "Do dia", width: 90, cell: (r, set) => <NumberInput {...num} allowDecimal={false} value={r.fromDay} onChange={(v) => typeof v === "number" && set({ fromDay: v })} /> },
          { header: "Até o dia", width: 90, cell: (r, set) => <NumberInput {...num} allowDecimal={false} value={r.toDay} onChange={(v) => typeof v === "number" && set({ toDay: v })} /> },
        ]}
      />
    </Card>
  );
}
