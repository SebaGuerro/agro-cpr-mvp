import { Alert, Anchor, Badge, Button, Card, Center, FileInput, Group, Loader, Modal, NumberInput, Select, Stack, Text, Title, Tooltip, type NumberInputProps } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconClockHour4, IconLink, IconUpload } from "@tabler/icons-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { uploadFile } from "../api/client";
import { useOrgs } from "../api/queries";
import type { EventRecord, OrgRef } from "../api/types";
import { notifyError, problemMessage } from "../lib/events";
import { env } from "../lib/env";
import { fmtDateTime, fmtSacas } from "../lib/format";
import { CPR_STATUS_LABEL, GRADE_COLOR, SEVERITY_COLOR, SEVERITY_LABEL, STAGE_LABEL } from "../lib/labels";

// ---------- page structure ----------

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-end" mb="lg" wrap="wrap" gap="sm">
      <div>
        <Title order={2}>{title}</Title>
        {subtitle && (
          <Text c="dimmed" size="sm">
            {subtitle}
          </Text>
        )}
      </div>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

/** Loading spinner, error message, or the content once the query has data. */
export function QueryGate<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (query.isError) {
    return (
      <Alert color="red" icon={<IconAlertTriangle />} title="Erro ao carregar">
        {problemMessage(query.error)}
      </Alert>
    );
  }
  return <>{query.data !== undefined && children(query.data)}</>;
}

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card withBorder padding="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text component="div" size="xl" fw={700} mt={4} style={{ overflowWrap: "anywhere" }}>
        {value}
      </Text>
      {hint && (
        <Text component="div" size="xs" c="dimmed" mt={2}>
          {hint}
        </Text>
      )}
    </Card>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <Text c="dimmed" ta="center" py="lg" size="sm">
      {children}
    </Text>
  );
}

// ---------- badges ----------

export function RiskBadge({ grade, score }: { grade: string; score?: number }) {
  return (
    <Tooltip label={score === undefined ? "Nota de risco" : `Pontuação ${score} de 100 (maior = mais risco)`}>
      <Badge color={GRADE_COLOR[grade] ?? "gray"} variant="filled" size="lg" radius="sm">
        {grade}
      </Badge>
    </Tooltip>
  );
}

export const StageBadge = ({ stage }: { stage: string }) => <Badge variant="light">{STAGE_LABEL[stage] ?? stage}</Badge>;

export function CprBadge({ status }: { status: string }) {
  const color = status === "NONE" ? "gray" : status === "SETTLED" ? "teal" : "indigo";
  return (
    <Badge color={color} variant="light">
      {CPR_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export const SeverityBadge = ({ severity }: { severity: string }) => (
  <Badge color={SEVERITY_COLOR[severity] ?? "gray"} style={{ flexShrink: 0 }}>
    {SEVERITY_LABEL[severity] ?? severity}
  </Badge>
);

/** Whether the event is on the chain yet, with a link to the transaction. */
export function AnchorBadge({ anchor }: { anchor: EventRecord["anchor"] }) {
  if (anchor.status === "ANCHORED") {
    const badge = (
      <Badge color="teal" variant="light" leftSection={<IconCircleCheck size={12} />}>
        Na blockchain
      </Badge>
    );
    // Only Base Sepolia (84532) has an explorer; the local mock chain (31337) doesn't.
    return anchor.txHash && anchor.chainId === 84532 ? (
      <Anchor href={`${env.explorerTxUrl}${anchor.txHash}`} target="_blank" rel="noreferrer" size="xs">
        <Group gap={4} wrap="nowrap">
          {badge}
          <IconLink size={12} />
        </Group>
      </Anchor>
    ) : (
      <Tooltip label={`Ancorado em ${fmtDateTime(anchor.anchoredAt)}`}>{badge}</Tooltip>
    );
  }
  if (anchor.status === "FAILED") {
    return (
      <Badge color="red" variant="light" leftSection={<IconAlertTriangle size={12} />}>
        Falha ao ancorar
      </Badge>
    );
  }
  return (
    <Tooltip label="Registrado no sistema; aguardando o registro na blockchain">
      <Badge color="gray" variant="light" leftSection={<IconClockHour4 size={12} />}>
        Pendente
      </Badge>
    </Tooltip>
  );
}

// ---------- inputs ----------

const ptNumber = { decimalSeparator: ",", thousandSeparator: "." } as const;

/** Whole kilograms, with the equivalent in 60 kg sacas underneath. */
export function KgInput(props: Omit<NumberInputProps, "onChange" | "value"> & { value: number | ""; onChange(v: number | ""): void }) {
  const { value, onChange, description, ...rest } = props;
  return (
    <NumberInput
      {...ptNumber}
      allowDecimal={false}
      min={0}
      suffix=" kg"
      value={value}
      onChange={(v) => onChange(typeof v === "number" ? v : "")}
      description={description ?? (typeof value === "number" && value > 0 ? `${fmtSacas(value)} de 60 kg` : undefined)}
      {...rest}
    />
  );
}

const parseNumber = (v: number | string): number | "" => (typeof v === "number" ? v : v.trim() === "" || Number.isNaN(Number(v)) ? "" : Number(v));

/**
 * Mantine reports decimals as strings while typing ("15." or "15.0"), and a string fed back
 * as the value is misread with a decimal comma. So the field stays uncontrolled and keeps its
 * own text; the form gets a number (or ""). It remounts only when the form changes the value
 * from outside (initial values, form.reset).
 */
function useNumberField(value: number | "" | undefined, emit: (v: number | "") => void) {
  const last = useRef<number | "">(value ?? "");
  const [key, setKey] = useState(0);
  useEffect(() => {
    if ((value ?? "") !== last.current) {
      last.current = value ?? "";
      setKey((k) => k + 1);
    }
  }, [value]);
  return {
    key,
    defaultValue: value ?? "",
    onChange(v: number | string) {
      last.current = parseNumber(v);
      emit(last.current);
    },
  };
}

/** Reais in the field, cents in the value. */
export function BrlInput(props: Omit<NumberInputProps, "onChange" | "value" | "defaultValue"> & { cents: number | ""; onChangeCents(v: number | ""): void }) {
  const { cents, onChangeCents, ...rest } = props;
  const reais = cents === "" ? "" : cents / 100;
  const field = useNumberField(reais, (v) => onChangeCents(v === "" ? "" : Math.round(v * 100)));
  return <NumberInput {...ptNumber} decimalScale={2} min={0} prefix="R$ " key={field.key} defaultValue={field.defaultValue} onChange={field.onChange} {...rest} />;
}

/** A decimal number with a comma; the form receives a number or "". */
export function DecimalInput(props: Omit<NumberInputProps, "onChange" | "value" | "defaultValue"> & { value?: number | ""; onChange?(v: number | ""): void }) {
  const { value, onChange, ...rest } = props;
  const field = useNumberField(value, (v) => onChange?.(v));
  return <NumberInput {...ptNumber} decimalScale={2} min={0} {...rest} key={field.key} defaultValue={field.defaultValue} onChange={field.onChange} />;
}

/** Uploads the evidence file right away and keeps its SHA-256, which the event cites. */
export function EvidenceInput({ label, required, onHash, description }: { label: string; required?: boolean; onHash(hash: string | null): void; description?: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<"idle" | "uploading" | "done">("idle");
  return (
    <FileInput
      label={label}
      required={required}
      placeholder="Escolher arquivo (PDF, foto)"
      leftSection={state === "uploading" ? <Loader size={14} /> : <IconUpload size={16} />}
      value={file}
      description={state === "done" ? "Arquivo enviado" : (description ?? "Nota fiscal, receituário, laudo ou foto")}
      clearable
      onChange={async (f) => {
        setFile(f);
        onHash(null);
        if (!f) return setState("idle");
        setState("uploading");
        try {
          const ref = await uploadFile(f);
          onHash(ref.sha256);
          setState("done");
        } catch (err) {
          notifyError(err);
          setFile(null);
          setState("idle");
        }
      }}
    />
  );
}

export function OrgSelect({ kind, label, value, onChange, only, required }: { kind: OrgRef["kind"]; label: string; value: string | null; onChange(v: string | null): void; only?: string[]; required?: boolean }) {
  const orgs = useOrgs(kind);
  const data = (orgs.data ?? []).filter((o) => !only || only.includes(o.id)).map((o) => ({ value: o.id, label: o.name }));
  return <Select label={label} data={data} value={value} onChange={onChange} searchable required={required} placeholder={orgs.isLoading ? "Carregando…" : "Escolha"} />;
}

// ---------- modal form ----------

export function FormModal({
  opened,
  onClose,
  title,
  onSubmit,
  loading,
  submitLabel = "Registrar",
  children,
  size = "md",
}: {
  opened: boolean;
  onClose(): void;
  title: string;
  onSubmit(): void | Promise<void>;
  loading?: boolean;
  submitLabel?: string;
  children: ReactNode;
  size?: string;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={700}>{title}</Text>} size={size} fullScreen={false}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <Stack gap="sm">
          {children}
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={loading}>
              {submitLabel}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
