import PgBoss from "pg-boss";

export interface JobTasks {
  anchor(): Promise<unknown>;
  alerts(): Promise<unknown>;
  reconcile(): Promise<unknown>;
}

export interface Jobs {
  /** Ask for an anchoring sweep soon (after an event is accepted). */
  triggerAnchor(): void;
  stop(): Promise<void>;
}

type Log = (msg: string, err?: unknown) => void;

const SCHEDULES = { anchor: "* * * * *", alerts: "*/15 * * * *", reconcile: "*/30 * * * *" } as const;

/**
 * pg-boss queues in the same Postgres. The "stately" policy keeps at most one
 * queued and one active job per queue, so sweeps never overlap and the relayer
 * key never sends two transactions at once.
 */
export async function startPgBossJobs(connectionString: string, tasks: JobTasks, log: Log): Promise<Jobs> {
  const boss = new PgBoss({ connectionString });
  boss.on("error", (err) => log("pg-boss error", err));
  await boss.start();

  for (const name of Object.keys(SCHEDULES) as (keyof JobTasks)[]) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name, { name, policy: "stately" });
    await boss.schedule(name, SCHEDULES[name]);
    await boss.work(name, async () => {
      await tasks[name]();
    });
  }

  return {
    triggerAnchor() {
      boss.send("anchor", {}).catch((err) => log("could not enqueue anchor sweep", err));
    },
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}

/** For PGlite (local dev): timers in this process, with the same no-overlap rule. */
export function startIntervalJobs(tasks: JobTasks, log: Log): Jobs {
  const running = new Set<keyof JobTasks>();
  const run = (name: keyof JobTasks) => {
    if (running.has(name)) return;
    running.add(name);
    tasks[name]()
      .catch((err) => log(`${name} job failed`, err))
      .finally(() => running.delete(name));
  };
  const timers = [
    setInterval(() => run("anchor"), 30_000),
    setInterval(() => run("alerts"), 15 * 60_000),
    setInterval(() => run("reconcile"), 30 * 60_000),
  ];
  return {
    triggerAnchor() {
      setTimeout(() => run("anchor"), 500);
    },
    async stop() {
      timers.forEach(clearInterval);
    },
  };
}
