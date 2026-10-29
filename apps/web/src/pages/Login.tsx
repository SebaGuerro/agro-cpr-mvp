import { Alert, Button, Card, Center, Divider, PasswordInput, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { IconLeaf } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DEV_USERS, useSession } from "../auth/session";
import { env } from "../lib/env";

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [devUser, setDevUser] = useState<string | null>(DEV_USERS[0]!.id);
  const [customId, setCustomId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ color: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (session.token) return <Navigate to="/" />;

  const enter = () => {
    qc.clear();
    void navigate({ to: "/" });
  };

  return (
    <Center mih="100vh" p="md" bg="var(--mantine-color-gray-0)">
      <Card withBorder shadow="sm" w={420} maw="100%" padding="xl">
        <Stack>
          <Stack gap={4} align="center">
            <IconLeaf size={36} color="var(--mantine-color-green-7)" />
            <Title order={3}>Agro CPR</Title>
            <Text size="sm" c="dimmed" ta="center">
              Do plantio à liquidação da CPR, com cada etapa registrada em blockchain.
            </Text>
          </Stack>
          {message && <Alert color={message.color}>{message.text}</Alert>}

          {env.authMode === "dev" ? (
            <>
              <Alert color="yellow" title="Modo de desenvolvimento">
                Entre como um dos usuários de demonstração. A API precisa estar com AUTH_MODE=dev.
              </Alert>
              <Select label="Usuário" data={DEV_USERS.map((u) => ({ value: u.id, label: u.label }))} value={devUser} onChange={setDevUser} allowDeselect={false} />
              <Button
                onClick={() => {
                  if (!devUser) return;
                  session.signInDev(devUser);
                  enter();
                }}
              >
                Entrar
              </Button>
              <Divider label="ou um usuário convidado" />
              <TextInput label="Id do usuário" placeholder="uuid" value={customId} onChange={(e) => setCustomId(e.currentTarget.value.trim())} />
              <Button
                variant="default"
                disabled={!/^[0-9a-f-]{36}$/i.test(customId)}
                onClick={() => {
                  session.signInDev(customId);
                  enter();
                }}
              >
                Entrar com este id
              </Button>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await session.signInPassword(email, password);
                  enter();
                } catch (err) {
                  setMessage({ color: "red", text: err instanceof Error ? err.message : String(err) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Stack>
                <TextInput label="E-mail" type="email" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
                <PasswordInput label="Senha" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
                <Button type="submit" loading={busy}>
                  Entrar
                </Button>
                <Button
                  variant="subtle"
                  disabled={!email}
                  onClick={async () => {
                    try {
                      await session.sendMagicLink(email);
                      setMessage({ color: "green", text: "Enviamos um link de acesso para o seu e-mail." });
                    } catch (err) {
                      setMessage({ color: "red", text: err instanceof Error ? err.message : String(err) });
                    }
                  }}
                >
                  Receber link de acesso por e-mail
                </Button>
              </Stack>
            </form>
          )}
        </Stack>
      </Card>
    </Center>
  );
}
