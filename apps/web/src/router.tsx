import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AuthedLayout } from "./components/Layout";
import { ConfigPage } from "./pages/Config";
import { CycleDetailPage } from "./pages/CycleDetail";
import { ImportsPage } from "./pages/Imports";
import { AlertsPage, CyclesPage, HomeRedirect } from "./pages/Lists";
import { LoginPage } from "./pages/Login";
import { DispatchPage, PlotDetailPage, ProducerHomePage } from "./pages/Producer";
import { ArrivalsPage, InsurerPage, PortfolioPage } from "./pages/Roles";
import { UsersPage } from "./pages/Users";

const root = createRootRoute({ component: Outlet });
const login = createRoute({ getParentRoute: () => root, path: "/login", component: LoginPage });
const app = createRoute({ getParentRoute: () => root, id: "app", component: AuthedLayout });
const r0 = createRoute({ getParentRoute: () => app, path: "/", component: HomeRedirect });
const r1 = createRoute({ getParentRoute: () => app, path: "/produtor", component: ProducerHomePage });
const r2 = createRoute({ getParentRoute: () => app, path: "/despacho", component: DispatchPage });
const r3 = createRoute({ getParentRoute: () => app, path: "/talhoes/$plotId", component: PlotDetailPage });
const r4 = createRoute({ getParentRoute: () => app, path: "/ciclos", component: CyclesPage });
const r5 = createRoute({ getParentRoute: () => app, path: "/ciclos/$cycleId", component: CycleDetailPage });
const r6 = createRoute({ getParentRoute: () => app, path: "/carteira", component: PortfolioPage });
const r7 = createRoute({ getParentRoute: () => app, path: "/chegadas", component: ArrivalsPage });
const r8 = createRoute({ getParentRoute: () => app, path: "/seguros", component: InsurerPage });
const r9 = createRoute({ getParentRoute: () => app, path: "/alertas", component: AlertsPage });
const r10 = createRoute({ getParentRoute: () => app, path: "/importacoes", component: ImportsPage });
const r11 = createRoute({ getParentRoute: () => app, path: "/configuracoes", component: ConfigPage });
const r12 = createRoute({ getParentRoute: () => app, path: "/usuarios", component: UsersPage });

const routeTree = root.addChildren([login, app.addChildren([r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12])]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
