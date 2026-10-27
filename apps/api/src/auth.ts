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
