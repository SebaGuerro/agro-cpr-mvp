import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";

/** Returns the authenticated user id for a bearer token, or null. */
export type AuthVerifier = (token: string) => Promise<string | null>;

export function supabaseVerifier(supabaseUrl: string, legacySecret?: string): AuthVerifier {
  const issuer = `${supabaseUrl}/auth/v1`;
  const key = legacySecret
    ? new TextEncoder().encode(legacySecret)
    : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1], {
        issuer,
        audience: "authenticated",
      });
      return typeof payload.sub === "string" ? payload.sub : null;
    } catch {
      return null;
    }
  };
}

/** Local development only: "Bearer dev:<userId>". Refused in production by config. */
export const devVerifier: AuthVerifier = async (token) => (token.startsWith("dev:") ? token.slice(4) : null);

/** Supabase sends the invitation email; the new user sets a password from the link. */
export function supabaseInviter(supabaseUrl: string, serviceRoleKey: string) {
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  return async (email: string): Promise<string> => {
    const { data, error } = await client.auth.admin.inviteUserByEmail(email);
    if (error || !data.user) throw new Error(`Supabase invite failed: ${error?.message ?? "no user returned"}`);
    return data.user.id;
  };
}

/** Local development: no email; the new user signs in with the dev token "dev:<userId>". */
export const devInviter = async (): Promise<string> => randomUUID();
