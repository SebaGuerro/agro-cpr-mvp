import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setTokenSource } from "../api/client";
import { env } from "../lib/env";

interface SessionValue {
  token: string | null;
  ready: boolean;
  signInDev(userId: string): void;
  signInPassword(email: string, password: string): Promise<void>;
  sendMagicLink(email: string): Promise<void>;
  signOut(): Promise<void>;
}

const DEV_KEY = "agro.devUser";
const SessionContext = createContext<SessionValue | null>(null);

const supabase: SupabaseClient | null =
  env.authMode === "supabase" && env.supabaseUrl && env.supabaseAnonKey ? createClient(env.supabaseUrl, env.supabaseAnonKey) : null;

function readDevUser(): string | null {
  try {
    return localStorage.getItem(DEV_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    if (env.authMode !== "dev") return null;
    const id = readDevUser();
    return id ? `dev:${id}` : null;
  });
  const [ready, setReady] = useState(env.authMode === "dev" || !supabase);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setToken(session?.access_token ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  setTokenSource(() => token);

  const value = useMemo<SessionValue>(
    () => ({
      token,
      ready,
      signInDev(userId) {
        try {
          localStorage.setItem(DEV_KEY, userId);
        } catch {
          // Private mode: the session lasts until reload.
        }
        setToken(`dev:${userId}`);
      },
      async signInPassword(email, password) {
        if (!supabase) throw new Error("Supabase não configurado");
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      async sendMagicLink(email) {
        if (!supabase) throw new Error("Supabase não configurado");
        const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
        if (error) throw error;
      },
      async signOut() {
        if (supabase) await supabase.auth.signOut();
        try {
          localStorage.removeItem(DEV_KEY);
        } catch {
          // Nothing stored.
        }
        setToken(null);
      },
    }),
    [token, ready],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

/** The seeded demo users (apps/api/src/seed/scenario.ts), for the dev login picker. */
const seedUser = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const DEV_USERS = [
  { id: seedUser(202), label: "Produtor — Fazenda Boa Vista (MT)" },
  { id: seedUser(203), label: "Produtor — Sítio Santa Rita (PR)" },
  { id: seedUser(204), label: "Armazém — Armazém Central" },
  { id: seedUser(206), label: "Financiador — Securitizadora Campo" },
  { id: seedUser(207), label: "Seguradora — Safra Segura" },
  { id: seedUser(205), label: "Comprador — Trading Grão Forte" },
  { id: seedUser(201), label: "Administrador da plataforma" },
];
