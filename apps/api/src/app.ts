import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthVerifier } from "./auth.js";
import type { LedgerKeys } from "./chain/ledger.js";
import type { Db } from "./db/client.js";
import { memberships } from "./db/schema.js";
import { ApiError } from "./domain/errors.js";
import type { Actor } from "./domain/types.js";
import { adminRoutes } from "./routes/admin.js";
import { alertRoutes } from "./routes/alerts.js";
import { configRoutes } from "./routes/config.js";
import { coreRoutes } from "./routes/core.js";
import { cycleRoutes } from "./routes/cycles.js";
import { eventRoutes } from "./routes/events.js";
import { importRoutes } from "./routes/imports.js";
import type { FileStorage } from "./storage.js";

export interface AppDeps {
  db: Db;
  verify: AuthVerifier;
  storage: FileStorage;
  keys: LedgerKeys;
  now: () => Date;
  toleranceBps: number;
  corsOrigins: string[];
  /** Called after an event is accepted, e.g. to wake the anchoring worker. */
  onEventRecorded?: () => void;
  /** How long imported events wait before anchoring (the rollback window). Default 30 minutes. */
  importHoldMs?: number;
  /** Creates (or invites) an auth user for this email and returns its user id. */
  inviteUser?: (email: string) => Promise<string>;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new ApiError("UNAUTHENTICATED", "Missing or invalid bearer token");
  return req.actor;
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "Request validation failed",
      result.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return result.data;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: deps.corsOrigins });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

  app.decorateRequest("actor", null);
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const userId = token ? await deps.verify(token) : null;
    if (!userId) throw new ApiError("UNAUTHENTICATED", "Missing or invalid bearer token");
    const [member] = await deps.db.select().from(memberships).where(eq(memberships.userId, userId));
    if (!member) throw new ApiError("FORBIDDEN_ORG", "This user is not linked to any organization yet");
    req.actor = { userId, orgId: member.orgId, role: member.role };
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply
        .code(err.status)
        .type("application/problem+json")
        .send({ type: "about:blank", title: err.code, status: err.status, code: err.code, detail: err.message, errors: err.errors });
    }
    const status = typeof (err as { statusCode?: unknown }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 500;
    if (status < 500) {
      return reply
        .code(status)
        .type("application/problem+json")
        .send({ type: "about:blank", title: "VALIDATION_FAILED", status, code: "VALIDATION_FAILED", detail: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).type("application/problem+json").send({ type: "about:blank", title: "INTERNAL", status: 500, code: "INTERNAL", detail: "Unexpected error" });
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(coreRoutes(deps));
  await app.register(cycleRoutes(deps));
  await app.register(eventRoutes(deps));
  await app.register(alertRoutes(deps));
  await app.register(configRoutes(deps));
  await app.register(importRoutes(deps));
  await app.register(adminRoutes(deps));
  return app;
}
