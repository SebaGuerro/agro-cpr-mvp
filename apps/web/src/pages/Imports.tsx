import { Alert, Badge, Button, Card, FileInput, Group, Select, SimpleGrid, Stack, Switch, Table, Text, Title } from "@mantine/core";
import { IconDownload, IconFileSpreadsheet, IconUpload } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { api, downloadFile, rawFetch, unwrap } from "../api/client";
import { useActor, useImports, useWrite } from "../api/queries";
import type { ImportBatch, Role } from "../api/types";
import { Empty, PageHeader, QueryGate, StatCard } from "../components/common";
import { notifyError, notifySaved } from "../lib/events";
import { fmtDateTime } from "../lib/format";

const KINDS: { value: ImportBatch["kind"]; label: string; roles: Role[] }[] = [
  { value: "PLOTS", label: "Talhões", roles: ["PRODUCER", "ADMIN"] },
  { value: "PLANTINGS", label: "Plantios", roles: ["PRODUCER", "ADMIN"] },
  { value: "INPUT_APPLICATIONS", label: "Aplicações de insumos", roles: ["PRODUCER", "ADMIN"] },
  { value: "DELIVERIES", label: "Entregas (caminhões)", roles: ["PRODUCER", "WAREHOUSE", "ADMIN"] },
  { value: "PLANTING_WINDOWS", label: "Janelas de plantio (substitui a tabela)", roles: ["ADMIN"] },
  { value: "DISCOUNT_TABLES", label: "Tabelas de desconto (substitui a tabela)", roles: ["ADMIN"] },
];
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;

const STATUS: Record<string, { label: string; color: string }> = {
  VALIDATED: { label: "Validado (simulação)", color: "blue" },
  APPLIED: { label: "Aplicado", color: "teal" },
  ROLLED_BACK: { label: "Desfeito", color: "gray" },
  FAILED: { label: "Com erros", color: "red" },
};

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ImportsPage() {
  const me = useActor();
  const kinds = KINDS.filter((k) => k.roles.includes(me.role));
  const [kind, setKind] = useState<string | null>(kinds[0]?.value ?? null);
  const [file, setFile] = useState<File | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [current, setCurrent] = useState<ImportBatch | null>(null);
  const history = useImports();

  const upload = useWrite(async () => {
    const form = new FormData();
    form.append("kind", kind!);
    form.append("dryRun", String(dryRun));
    form.append("file", file!);
    return (await rawFetch("/v1/imports", { method: "POST", body: form })).json() as Promise<ImportBatch>;
  });

  return (
    <>
      <PageHeader title="Importar planilhas" subtitle="CSV ou Excel, até 2.000 linhas. Valide primeiro; o lote entra inteiro ou não entra." />
      <SimpleGrid cols={{ base: 1, md: 2 }} mb="lg">
        <Card withBorder>
          <Stack>
            <Title order={4}>1. Modelo</Title>
            <Select label="O que importar" data={kinds.map((k) => ({ value: k.value, label: k.label }))} value={kind} onChange={setKind} allowDeselect={false} />
            <Text size="sm" c="dimmed">
              O modelo traz os cabeçalhos em português, listas de opções e uma aba com os seus talhões, safras e arquivos já enviados.
            </Text>
            <Button variant="light" leftSection={<IconDownload size={16} />} disabled={!kind} onClick={() => downloadFile(`/v1/imports/templates/${kind}`, "modelo.xlsx").catch(notifyError)}>
              Baixar modelo (.xlsx)
            </Button>
          </Stack>
        </Card>
        <Card withBorder>
          <Stack>
            <Title order={4}>2. Enviar</Title>
            <FileInput label="Planilha" accept=".csv,.xlsx" leftSection={<IconFileSpreadsheet size={16} />} placeholder="Escolher arquivo" value={file} onChange={setFile} clearable />
            <Switch label="Só validar (simulação, não grava nada)" checked={dryRun} onChange={(e) => setDryRun(e.currentTarget.checked)} />
            <Button
              leftSection={<IconUpload size={16} />}
              disabled={!file || !kind}
              loading={upload.isPending}
              onClick={() =>
                upload.mutate(undefined, {
                  onSuccess: (b) => {
                    setCurrent(b);
                    if (b.status === "APPLIED") notifySaved(`${b.eventCount} registros gravados`);
                  },
                  onError: notifyError,
                })
              }
            >
              {dryRun ? "Validar" : "Validar e aplicar"}
            </Button>
          </Stack>
        </Card>
      </SimpleGrid>

      {current && <BatchCard batch={current} onChange={setCurrent} />}

      <Card withBorder mt="lg">
        <Title order={4} mb="sm">
          Histórico
        </Title>
        <QueryGate query={history}>
          {(items) =>
            items.length === 0 ? (
              <Empty>Nenhuma importação ainda.</Empty>
            ) : (
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Quando</Table.Th>
                    <Table.Th>Tipo</Table.Th>
                    <Table.Th>Arquivo</Table.Th>
                    <Table.Th>Linhas</Table.Th>
                    <Table.Th>Situação</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {items.map((b) => (
                    <Table.Tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setCurrent(b)}>
                      <Table.Td>{fmtDateTime(b.createdAt)}</Table.Td>
                      <Table.Td>{kindLabel(b.kind)}</Table.Td>
                      <Table.Td>{b.fileName ?? "—"}</Table.Td>
                      <Table.Td>
                        {b.totalRows} ({b.rejectedRows} com erro)
                      </Table.Td>
                      <Table.Td>
                        <Badge color={STATUS[b.status]?.color}>{STATUS[b.status]?.label ?? b.status}</Badge>
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

function BatchCard({ batch, onChange }: { batch: ImportBatch; onChange(b: ImportBatch): void }) {
  const now = useNow(15_000);
  const apply = useWrite(() => unwrap<ImportBatch>(api.POST("/v1/imports/{batchId}/apply", { params: { path: { batchId: batch.id } } })));
  const rollback = useWrite(() => unwrap<ImportBatch>(api.POST("/v1/imports/{batchId}/rollback", { params: { path: { batchId: batch.id } } })));
  const until = batch.rollbackAvailableUntil ? Date.parse(batch.rollbackAvailableUntil) : null;
  const minutesLeft = until ? Math.max(0, Math.ceil((until - now) / 60_000)) : null;
  const canRollback = batch.status === "APPLIED" && (until === null || until > now);
  const status = STATUS[batch.status];

  return (
    <Card withBorder>
      <Group justify="space-between" mb="md">
        <div>
          <Title order={4}>
            {kindLabel(batch.kind)} — {batch.fileName ?? "arquivo"}
          </Title>
          <Text size="xs" c="dimmed">
            {fmtDateTime(batch.createdAt)} · {batch.format}
          </Text>
        </div>
        <Badge size="lg" color={status?.color}>
          {status?.label ?? batch.status}
        </Badge>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 4 }} mb="md">
        <StatCard label="Linhas" value={batch.totalRows} />
        <StatCard label="Novas" value={batch.acceptedRows} />
        <StatCard label="Já existiam" value={batch.unchangedRows} hint="reenvio do mesmo arquivo" />
        <StatCard label="Com erro" value={batch.rejectedRows} />
      </SimpleGrid>

      {batch.status === "VALIDATED" && batch.dryRun && <Alert color="blue" mb="md">Nenhum erro. Nada foi gravado ainda: aplique para gravar.</Alert>}
      {batch.status === "FAILED" && <Alert color="red" mb="md">Nada foi gravado. Baixe a planilha com a coluna "erro", corrija e envie de novo.</Alert>}
      {batch.status === "APPLIED" && (
        <Alert color="teal" mb="md">
          {batch.eventCount} registros gravados.{" "}
          {until !== null && (minutesLeft! > 0 ? `Você pode desfazer o lote por mais ${minutesLeft} min; depois ele vai para a blockchain e só pode ser corrigido registro a registro.` : "A janela para desfazer terminou.")}
        </Alert>
      )}

      {batch.errors.length > 0 && (
        <Table mb="md" striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={70}>Linha</Table.Th>
              <Table.Th w={180}>Coluna</Table.Th>
              <Table.Th>Erro</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {batch.errors.slice(0, 200).map((e, i) => (
              <Table.Tr key={i}>
                <Table.Td>{e.row}</Table.Td>
                <Table.Td>{e.column ?? "—"}</Table.Td>
                <Table.Td>{e.message}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Group>
        {batch.status === "VALIDATED" && batch.dryRun && (
          <Button loading={apply.isPending} onClick={() => apply.mutate(undefined, { onSuccess: onChange, onError: notifyError })}>
            Aplicar
          </Button>
        )}
        {batch.errors.length > 0 && (
          <Button variant="light" leftSection={<IconDownload size={16} />} onClick={() => downloadFile(`/v1/imports/${batch.id}/annotated`, "erros.xlsx").catch(notifyError)}>
            Baixar planilha com erros
          </Button>
        )}
        {canRollback && (
          <Button color="red" variant="light" loading={rollback.isPending} onClick={() => rollback.mutate(undefined, { onSuccess: (b) => { onChange(b); notifySaved("Lote desfeito"); }, onError: notifyError })}>
            Desfazer lote
          </Button>
        )}
      </Group>
    </Card>
  );
}
