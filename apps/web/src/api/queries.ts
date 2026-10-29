import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../auth/session";
import { api, unwrap } from "./client";
import type {
  AdminOrg,
  AdminUser,
  Alert,
  ChecklistTemplate,
  CprRequest,
  CropCycle,
  DiscountTable,
  EventRecord,
  ExpectedArrival,
  Farm,
  Haircut,
  ImportBatch,
  Me,
  OrgRef,
  PlantingWindow,
  Plot,
  Portfolio,
  RiskAssessment,
} from "./types";

export function useMe() {
  const enabled = Boolean(useSession().token);
  return useQuery({ queryKey: ["me"], enabled, queryFn: () => unwrap<Me>(api.GET("/v1/me")), staleTime: 5 * 60_000, retry: false });
}

/** The signed-in user; only call below the authenticated layout, which waits for /v1/me. */
export function useActor(): Me {
  const me = useMe().data;
  if (!me) throw new Error("useActor before /v1/me loaded");
  return me;
}

export function useOrgs(kind?: OrgRef["kind"]) {
  return useQuery({
    queryKey: ["orgs", kind ?? "all"],
    queryFn: () => unwrap<OrgRef[]>(api.GET("/v1/orgs", { params: { query: kind ? { kind } : {} } })),
    staleTime: 5 * 60_000,
  });
}

export function useFarms() {
  return useQuery({ queryKey: ["farms"], queryFn: async () => (await unwrap(api.GET("/v1/farms"))).items as Farm[] });
}

export function usePlots() {
  return useQuery({ queryKey: ["plots"], queryFn: async () => (await unwrap(api.GET("/v1/plots", { params: { query: {} } }))).items as Plot[] });
}

export function usePlot(plotId: string) {
  return useQuery({ queryKey: ["plot", plotId], queryFn: () => unwrap<Plot>(api.GET("/v1/plots/{plotId}", { params: { path: { plotId } } })) });
}

export function usePlotTimeline(plotId: string) {
  return useQuery({
    queryKey: ["plot", plotId, "timeline"],
    queryFn: async () => (await unwrap(api.GET("/v1/plots/{plotId}/timeline", { params: { path: { plotId } } }))).events as unknown as EventRecord[],
  });
}

export function useCycles() {
  return useQuery({
    queryKey: ["cycles"],
    queryFn: async () => (await unwrap(api.GET("/v1/crop-cycles", { params: { query: {} } }))).items as CropCycle[],
    placeholderData: keepPreviousData,
  });
}

export function useCycle(cycleId: string) {
  return useQuery({ queryKey: ["cycle", cycleId], queryFn: () => unwrap<CropCycle>(api.GET("/v1/crop-cycles/{cycleId}", { params: { path: { cycleId } } })) });
}

export function useCycleTimeline(cycleId: string) {
  return useQuery({
    queryKey: ["cycle", cycleId, "timeline"],
    queryFn: async () => {
      const t = await unwrap(api.GET("/v1/crop-cycles/{cycleId}/timeline", { params: { path: { cycleId } } }));
      return { events: t.events as unknown as EventRecord[], planned: t.planned ?? {} };
    },
  });
}

export function useRisk(cycleId: string) {
  return useQuery({
    queryKey: ["cycle", cycleId, "risk"],
    queryFn: () => unwrap<RiskAssessment>(api.GET("/v1/crop-cycles/{cycleId}/risk", { params: { path: { cycleId } } })),
  });
}

export function useCycleInsurers(cycleId: string) {
  return useQuery({
    queryKey: ["cycle", cycleId, "insurers"],
    queryFn: () => unwrap<OrgRef[]>(api.GET("/v1/crop-cycles/{cycleId}/insurers", { params: { path: { cycleId } } })),
  });
}

export function useCprRequests(status?: CprRequest["status"]) {
  return useQuery({
    queryKey: ["cpr-requests", status ?? "all"],
    queryFn: () => unwrap<CprRequest[]>(api.GET("/v1/cpr-requests", { params: { query: status ? { status } : {} } })),
  });
}

export function useAlerts(opts: { open?: boolean; cycleId?: string } = {}) {
  const enabled = Boolean(useSession().token);
  const query: Record<string, string> = { open: opts.open === false ? "false" : "true" };
  if (opts.cycleId) query.cycleId = opts.cycleId;
  return useQuery({
    queryKey: ["alerts", query],
    enabled,
    queryFn: () => unwrap<Alert[]>(api.GET("/v1/alerts", { params: { query: query as never } })),
  });
}

export function usePortfolio() {
  return useQuery({ queryKey: ["portfolio"], queryFn: () => unwrap<Portfolio>(api.GET("/v1/portfolio")) });
}

export function useArrivals(warehouseOrgId: string | null) {
  return useQuery({
    queryKey: ["arrivals", warehouseOrgId],
    enabled: Boolean(warehouseOrgId),
    queryFn: () =>
      unwrap<ExpectedArrival[]>(api.GET("/v1/warehouses/{warehouseOrgId}/expected-arrivals", { params: { path: { warehouseOrgId: warehouseOrgId! } } })),
    refetchInterval: 60_000,
  });
}

export function useConfig() {
  const opts = { staleTime: 5 * 60_000 };
  const windows = useQuery({ ...opts, queryKey: ["config", "windows"], queryFn: () => unwrap<PlantingWindow[]>(api.GET("/v1/config/planting-windows")) });
  const haircuts = useQuery({ ...opts, queryKey: ["config", "haircuts"], queryFn: () => unwrap<Haircut[]>(api.GET("/v1/config/haircuts")) });
  const discounts = useQuery({ ...opts, queryKey: ["config", "discounts"], queryFn: () => unwrap<DiscountTable[]>(api.GET("/v1/config/discount-tables")) });
  const checklists = useQuery({ ...opts, queryKey: ["config", "checklists"], queryFn: () => unwrap<ChecklistTemplate[]>(api.GET("/v1/config/checklists")) });
  return {
    windows: windows.data ?? [],
    haircuts: haircuts.data ?? [],
    discounts: discounts.data ?? [],
    checklists: checklists.data ?? [],
    loading: windows.isLoading || haircuts.isLoading || discounts.isLoading || checklists.isLoading,
  };
}

export function useImports() {
  return useQuery({ queryKey: ["imports"], queryFn: () => unwrap<ImportBatch[]>(api.GET("/v1/imports")) });
}

export function useAdminOrgs() {
  return useQuery({ queryKey: ["admin", "orgs"], queryFn: () => unwrap<AdminOrg[]>(api.GET("/v1/admin/orgs")) });
}

export function useAdminUsers() {
  return useQuery({ queryKey: ["admin", "users"], queryFn: () => unwrap<AdminUser[]>(api.GET("/v1/admin/users")) });
}

/** Wraps a write. On success every query refetches, so all screens stay consistent. */
export function useWrite<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries() });
}
