import { Alert, Badge, Button, Card, Code, Grid, Select, Stack, Table, Tabs, Text, TextInput, Title } from "@mantine/core";
import { useForm } from "@mantine/form";
import { api, unwrap } from "../api/client";
import { useAdminOrgs, useAdminUsers, useWrite } from "../api/queries";
import type { AdminOrg } from "../api/types";
import { PageHeader, QueryGate } from "../components/common";
import { notifyError, notifySaved } from "../lib/events";
import { env } from "../lib/env";
import { ORG_KIND_LABEL, options, ROLE_LABEL } from "../lib/labels";

export function UsersPage() {
  const orgs = useAdminOrgs();
  const users = useAdminUsers();
  return (
    <>
      <PageHeader title="Usuários e organizações" subtitle="Cada usuário pertence a uma organização; o perfil segue o tipo da organização" />
      <Tabs defaultValue="users">
        <Tabs.List mb="md">
          <Tabs.Tab value="users">Usuários</Tabs.Tab>
          <Tabs.Tab value="orgs">Organizações</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="users">
          <Grid gutter="lg">
            <Grid.Col span={{ base: 12, md: 8 }}>
              <Card withBorder>
                <QueryGate query={users}>
                  {(items) => (
                    <Table>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Nome</Table.Th>
                          <Table.Th>E-mail</Table.Th>
                          <Table.Th>Organização</Table.Th>
                          <Table.Th>Perfil</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {items.map((u) => (
                          <Table.Tr key={u.userId}>
                            <Table.Td>{u.name ?? "—"}</Table.Td>
                            <Table.Td>{u.email ?? "—"}</Table.Td>
                            <Table.Td>{u.orgName}</Table.Td>
                            <Table.Td>
                              <Badge variant="light">{ROLE_LABEL[u.role]}</Badge>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                </QueryGate>
              </Card>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <InviteForm orgs={orgs.data ?? []} />
            </Grid.Col>
          </Grid>
        </Tabs.Panel>
        <Tabs.Panel value="orgs">
          <Grid gutter="lg">
            <Grid.Col span={{ base: 12, md: 8 }}>
              <Card withBorder>
                <QueryGate query={orgs}>
                  {(items) => (
                    <Table>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Nome</Table.Th>
                          <Table.Th>Tipo</Table.Th>
                          <Table.Th>CPF/CNPJ</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {items.map((o) => (
                          <Table.Tr key={o.id}>
                            <Table.Td>{o.name}</Table.Td>
                            <Table.Td>{ORG_KIND_LABEL[o.kind]}</Table.Td>
                            <Table.Td>{o.taxId ?? "—"}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                </QueryGate>
              </Card>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <OrgForm />
            </Grid.Col>
          </Grid>
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function InviteForm({ orgs }: { orgs: AdminOrg[] }) {
  const save = useWrite((body: { email: string; name: string; orgId: string }) => unwrap(api.POST("/v1/admin/users", { body })));
  const form = useForm({
    initialValues: { email: "", name: "", orgId: null as string | null },
    validate: { email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : "E-mail inválido"), name: (v) => (v.trim() ? null : "Obrigatório"), orgId: (v) => (v ? null : "Escolha a organização") },
  });
  return (
    <Card withBorder>
      <form
        onSubmit={form.onSubmit(async (v) => {
          try {
            const created = await save.mutateAsync({ email: v.email.trim(), name: v.name.trim(), orgId: v.orgId! });
            notifySaved(env.authMode === "dev" ? `Usuário criado. Para entrar: id ${created.userId}` : "Convite enviado por e-mail");
            form.reset();
          } catch (err) {
            notifyError(err);
          }
        })}
      >
        <Stack>
          <Title order={5}>Convidar usuário</Title>
          <TextInput label="Nome" required {...form.getInputProps("name")} />
          <TextInput label="E-mail" required {...form.getInputProps("email")} />
          <Select label="Organização" required searchable data={orgs.map((o) => ({ value: o.id, label: `${o.name} (${ORG_KIND_LABEL[o.kind]})` }))} {...form.getInputProps("orgId")} />
          {env.authMode === "dev" ? (
            <Alert color="yellow">
              Modo de desenvolvimento: nenhum e-mail é enviado. Entre com <Code>dev:&lt;id&gt;</Code> na tela de login.
            </Alert>
          ) : (
            <Text size="xs" c="dimmed">
              O Supabase envia o convite; a pessoa define a senha pelo link.
            </Text>
          )}
          <Button type="submit" loading={save.isPending}>
            Convidar
          </Button>
        </Stack>
      </form>
    </Card>
  );
}

function OrgForm() {
  const save = useWrite((body: { name: string; kind: AdminOrg["kind"]; taxId: string | null }) => unwrap(api.POST("/v1/admin/orgs", { body })));
  const form = useForm({
    initialValues: { name: "", kind: "PRODUCER" as AdminOrg["kind"], taxId: "" },
    validate: { name: (v) => (v.trim() ? null : "Obrigatório"), taxId: (v) => (!v || /^\d{11}$|^\d{14}$/.test(v.replace(/\D/g, "")) ? null : "CPF (11) ou CNPJ (14 dígitos)") },
  });
  return (
    <Card withBorder>
      <form
        onSubmit={form.onSubmit(async (v) => {
          try {
            await save.mutateAsync({ name: v.name.trim(), kind: v.kind, taxId: v.taxId.replace(/\D/g, "") || null });
            notifySaved("Organização criada");
            form.reset();
          } catch (err) {
            notifyError(err);
          }
        })}
      >
        <Stack>
          <Title order={5}>Nova organização</Title>
          <TextInput label="Nome" required {...form.getInputProps("name")} />
          <Select label="Tipo" data={options(ORG_KIND_LABEL)} allowDeselect={false} {...form.getInputProps("kind")} />
          <TextInput label="CPF/CNPJ" description="Fica só no banco de dados; nunca vai para a blockchain" {...form.getInputProps("taxId")} />
          <Button type="submit" loading={save.isPending}>
            Criar
          </Button>
        </Stack>
      </form>
    </Card>
  );
}
