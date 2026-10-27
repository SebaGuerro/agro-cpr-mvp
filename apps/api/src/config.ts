import { z } from "zod";

const Env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(3001),
    // Supabase session pooler (port 5432) in production; "pglite:./.data/pg" for local dev.
    DATABASE_URL: z.string().min(1),
    AUTH_MODE: z.enum(["supabase", "dev"]).default("supabase"),
    SUPABASE_URL: z.url().optional(),
    // Only for projects still on the legacy shared JWT secret; otherwise JWKS is used.
    SUPABASE_JWT_SECRET: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    STORAGE_MODE: z.enum(["supabase", "local"]).default("local"),
    STORAGE_BUCKET: z.string().default("evidence"),
    LOCAL_STORAGE_DIR: z.string().default("./.data/files"),
    LEDGER_KEY_SECRET: z.string().min(32, "use at least 32 random characters"),
    CHAIN_MODE: z.enum(["mock", "base-sepolia"]).default("mock"),
    BASE_SEPOLIA_RPC_URL: z.url().optional(),
    RELAYER_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    AGRO_LEDGER_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    DELIVERY_TOLERANCE_BPS: z.coerce.number().int().min(0).max(10_000).default(200),
    CORS_ORIGINS: z.string().default("http://localhost:3000"),
    RUN_WORKER: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
  })
  .superRefine((env, ctx) => {
    const need = (ok: unknown, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", message });
    };
    need(!(env.NODE_ENV === "production" && env.AUTH_MODE === "dev"), "AUTH_MODE=dev is not allowed in production");
    need(env.AUTH_MODE !== "supabase" || env.SUPABASE_URL, "AUTH_MODE=supabase needs SUPABASE_URL");
    need(
      env.STORAGE_MODE !== "supabase" || (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
      "STORAGE_MODE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
    need(
      env.CHAIN_MODE !== "base-sepolia" ||
        (env.BASE_SEPOLIA_RPC_URL && env.RELAYER_PRIVATE_KEY && env.AGRO_LEDGER_ADDRESS),
      "CHAIN_MODE=base-sepolia needs BASE_SEPOLIA_RPC_URL, RELAYER_PRIVATE_KEY and AGRO_LEDGER_ADDRESS",
    );
  });

export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
