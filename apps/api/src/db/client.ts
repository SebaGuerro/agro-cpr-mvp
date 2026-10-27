import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

// Works for Postgres (Supabase) and for an embedded PGlite database, and also
// types transactions, which are PgDatabase subtypes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: "postgres" | "pglite";
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// "pglite:<dir>" (or "pglite:memory") runs an embedded Postgres for local dev and tests.
export function createDb(url: string): DbHandle {
  if (url.startsWith("pglite:")) {
    const target = url.slice("pglite:".length);
    const client = target === "memory" ? new PGlite() : new PGlite(target);
    const db = drizzlePglite({ client, schema });
    return {
      db,
      kind: "pglite",
      migrate: () => migratePglite(db, { migrationsFolder }),
      close: () => client.close(),
    };
  }
  // prepare: false keeps it compatible with Supabase's connection pooler.
  const client = postgres(url, { max: 10, prepare: false });
  const db = drizzlePostgres({ client, schema });
  return {
    db,
    kind: "postgres",
    migrate: () => migratePostgres(db, { migrationsFolder }),
    close: () => client.end(),
  };
}
