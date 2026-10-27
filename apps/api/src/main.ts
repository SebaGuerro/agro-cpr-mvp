import { devVerifier, supabaseVerifier } from "./auth.js";
import { buildApp } from "./app.js";
import { LedgerKeys, type ChainAdapter } from "./chain/ledger.js";
import { createMockChain } from "./chain/mock.js";
import { createViemChain } from "./chain/viem.js";
import { loadEnv } from "./config.js";
import { createDb } from "./db/client.js";
import { anchorPending, reconcileAnchors } from "./jobs/anchor.js";
import { startIntervalJobs, startPgBossJobs, type Jobs } from "./jobs/runner.js";
import { syncCycleAlerts } from "./services/alerts.js";
import { diskStorage, supabaseStorage } from "./storage.js";

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);
const now = () => new Date();
const keys = new LedgerKeys(env.LEDGER_KEY_SECRET);

const chain: ChainAdapter =
  env.CHAIN_MODE === "base-sepolia"
    ? createViemChain({
        rpcUrl: env.BASE_SEPOLIA_RPC_URL!,
        privateKey: env.RELAYER_PRIVATE_KEY as `0x${string}`,
        address: env.AGRO_LEDGER_ADDRESS as `0x${string}`,
      })
    : createMockChain();

const storage =
  env.STORAGE_MODE === "supabase"
    ? supabaseStorage(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, env.STORAGE_BUCKET)
    : diskStorage(env.LOCAL_STORAGE_DIR);

const log = (msg: string, err?: unknown) => console.error(`[jobs] ${msg}`, err ?? "");
const tasks = {
  anchor: () => anchorPending(handle.db, chain, keys, { now }),
  alerts: () => syncCycleAlerts(handle.db, "all", { now: now(), toleranceBps: env.DELIVERY_TOLERANCE_BPS }),
  reconcile: () => reconcileAnchors(handle.db, chain, keys, { now }),
};

let jobs: Jobs | null = null;
if (env.RUN_WORKER) {
  jobs = handle.kind === "pglite" ? startIntervalJobs(tasks, log) : await startPgBossJobs(env.DATABASE_URL, tasks, log);
}

const app = await buildApp({
  db: handle.db,
  verify: env.AUTH_MODE === "dev" ? devVerifier : supabaseVerifier(env.SUPABASE_URL!, env.SUPABASE_JWT_SECRET),
  storage,
  keys,
  now,
  toleranceBps: env.DELIVERY_TOLERANCE_BPS,
  corsOrigins: env.CORS_ORIGINS.split(",").map((s) => s.trim()),
  onEventRecorded: () => jobs?.triggerAnchor(),
  logger: true,
});

if (env.CHAIN_MODE === "mock") app.log.warn("CHAIN_MODE=mock: anchors are in memory and lost on restart");

const shutdown = async () => {
  await app.close();
  await jobs?.stop();
  await handle.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: env.PORT });
