import { ROLES } from "@agro-cpr/spec";
import { asc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { actorOf, parse, type AppDeps } from "../app.js";
import { auditLog, memberships, ORG_KINDS, orgs } from "../db/schema.js";
import { fail } from "../domain/errors.js";
import type { Actor } from "../domain/types.js";

/** Which role a member of each kind of organization has. */
export const ROLE_FOR_KIND = {
  PLATFORM: "ADMIN",
  PRODUCER: "PRODUCER",
  WAREHOUSE: "WAREHOUSE",
  BUYER: "BUYER",
  FINANCIER: "FINANCIER",
  INSURER: "INSURER",
} as const satisfies Record<(typeof ORG_KINDS)[number], (typeof ROLES)[number]>;

const OrgInput = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(ORG_KINDS),
  taxId: z
    .string()
    .regex(/^\d{11}$|^\d{14}$/, "CPF (11 digits) or CNPJ (14 digits), numbers only")
    .nullable()
    .default(null),
});

const UserInput = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  orgId: z.uuid(),
});

function requireAdmin(actor: Actor) {
  if (actor.role !== "ADMIN") fail("FORBIDDEN_ROLE", "Admins only");
}

/** Organizations and users for the pilot's back office. One membership per user. */
export const adminRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.get("/v1/admin/orgs", async (req) => {
      requireAdmin(actorOf(req));
      return db.select().from(orgs).orderBy(asc(orgs.name));
    });

    app.post("/v1/admin/orgs", async (req, reply) => {
      const actor = actorOf(req);
      requireAdmin(actor);
      const input = parse(OrgInput, req.body);
      const [org] = await db.insert(orgs).values({ ...input, createdAt: deps.now() }).returning();
      await db.insert(auditLog).values({ userId: actor.userId, action: "CREATE", entity: "org", entityId: org!.id, data: { name: input.name, kind: input.kind }, at: deps.now() });
      return reply.code(201).send(org);
    });

    app.get("/v1/admin/users", async (req) => {
      requireAdmin(actorOf(req));
      return db
        .select({ userId: memberships.userId, email: memberships.email, name: memberships.name, role: memberships.role, orgId: orgs.id, orgName: orgs.name, createdAt: memberships.createdAt })
        .from(memberships)
        .innerJoin(orgs, eq(orgs.id, memberships.orgId))
        .orderBy(asc(orgs.name), asc(memberships.name));
    });

    // Invites the person (Supabase sends the email) and links them; the role follows the organization's kind.
    app.post("/v1/admin/users", async (req, reply) => {
      const actor = actorOf(req);
      requireAdmin(actor);
      const input = parse(UserInput, req.body);
      const [org] = await db.select().from(orgs).where(eq(orgs.id, input.orgId));
      if (!org) fail("NOT_FOUND", "Organization not found");
      const existing = (await db.select().from(memberships)).find((m) => m.email?.toLowerCase() === input.email.toLowerCase());
      if (existing) fail("VALIDATION_FAILED", "This email is already linked to an organization");
      if (!deps.inviteUser) fail("VALIDATION_FAILED", "User invitations are not configured on this server");
      const userId = await deps.inviteUser(input.email);
      const [member] = await db
        .insert(memberships)
        .values({ userId, orgId: org.id, role: ROLE_FOR_KIND[org.kind], email: input.email, name: input.name, createdAt: deps.now() })
        .returning();
      await db.insert(auditLog).values({ userId: actor.userId, action: "INVITE", entity: "membership", entityId: userId, data: { email: input.email, orgId: org.id }, at: deps.now() });
      return reply.code(201).send({ ...member, orgName: org.name });
    });
  };
