import { AppShell, Badge, Burger, Center, Group, Loader, NavLink, ScrollArea, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconAlertTriangle,
  IconBuildingWarehouse,
  IconChartPie,
  IconFileSpreadsheet,
  IconLeaf,
  IconListDetails,
  IconLogout,
  IconSettings,
  IconShieldCheck,
  IconTruckDelivery,
  IconUsers,
  type Icon,
} from "@tabler/icons-react";
import { Navigate, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useAlerts, useMe } from "../api/queries";
import type { Role } from "../api/types";
import { useSession } from "../auth/session";
import { problemMessage } from "../lib/events";
import { ROLE_LABEL } from "../lib/labels";

interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  roles: Role[];
}

const NAV: NavItem[] = [
  { to: "/produtor", label: "Fazendas e talhões", icon: IconLeaf, roles: ["PRODUCER", "ADMIN"] },
  { to: "/despacho", label: "Despachar caminhão", icon: IconTruckDelivery, roles: ["PRODUCER"] },
  { to: "/carteira", label: "Carteira", icon: IconChartPie, roles: ["FINANCIER", "ADMIN"] },
  { to: "/chegadas", label: "Chegadas e classificação", icon: IconBuildingWarehouse, roles: ["WAREHOUSE", "ADMIN"] },
  { to: "/seguros", label: "Apólices e sinistros", icon: IconShieldCheck, roles: ["INSURER", "ADMIN"] },
  { to: "/ciclos", label: "Ciclos", icon: IconListDetails, roles: ["PRODUCER", "WAREHOUSE", "BUYER", "FINANCIER", "INSURER", "ADMIN"] },
  { to: "/alertas", label: "Alertas", icon: IconAlertTriangle, roles: ["PRODUCER", "WAREHOUSE", "BUYER", "FINANCIER", "INSURER", "ADMIN"] },
  { to: "/importacoes", label: "Importar planilhas", icon: IconFileSpreadsheet, roles: ["PRODUCER", "WAREHOUSE", "ADMIN"] },
  { to: "/configuracoes", label: "Configurações", icon: IconSettings, roles: ["ADMIN"] },
  { to: "/usuarios", label: "Usuários e organizações", icon: IconUsers, roles: ["ADMIN"] },
];

/** The home screen for each role. */
export const HOME: Record<Role, string> = {
  PRODUCER: "/produtor",
  FINANCIER: "/carteira",
  WAREHOUSE: "/chegadas",
  INSURER: "/seguros",
  BUYER: "/ciclos",
  ADMIN: "/ciclos",
};

export function AuthedLayout() {
  const session = useSession();
  const me = useMe();
  const [opened, { toggle, close }] = useDisclosure();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const openAlerts = useAlerts({ open: true }).data?.filter((a) => a.severity === "HIGH" && !a.ackedAt).length ?? 0;

  if (!session.ready) return <Center h="100vh"><Loader /></Center>;
  if (!session.token) return <Navigate to="/login" />;
  if (me.isLoading) return <Center h="100vh"><Loader /></Center>;
  if (me.isError || !me.data) {
    return (
      <Center h="100vh">
        <Stack align="center">
          <Text>{problemMessage(me.error)}</Text>
          <Text c="blue" style={{ cursor: "pointer" }} onClick={() => void session.signOut()}>
            Entrar com outro usuário
          </Text>
        </Stack>
      </Center>
    );
  }
  const role = me.data.role;

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 260, breakpoint: "sm", collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <IconLeaf color="var(--mantine-color-green-7)" />
            <Text fw={700}>Agro CPR</Text>
            <Badge variant="light" visibleFrom="xs">
              Piloto (testnet)
            </Badge>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" fw={500} truncate maw={220}>
              {me.data.orgName}
            </Text>
            <Badge color="gray" visibleFrom="xs">
              {ROLE_LABEL[role]}
            </Badge>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea}>
          {NAV.filter((n) => n.roles.includes(role)).map((n) => (
            <NavLink
              key={n.to}
              label={n.label}
              leftSection={<n.icon size={18} />}
              active={path === n.to || path.startsWith(`${n.to}/`)}
              rightSection={n.to === "/alertas" && openAlerts > 0 ? <Badge color="red" size="sm">{openAlerts}</Badge> : undefined}
              onClick={() => {
                close();
                void navigate({ to: n.to });
              }}
            />
          ))}
        </AppShell.Section>
        <AppShell.Section>
          <NavLink label="Sair" leftSection={<IconLogout size={18} />} onClick={() => void session.signOut()} />
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
