export const env = {
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3001",
  authMode: ((import.meta.env.VITE_AUTH_MODE as string | undefined) ?? "dev") as "dev" | "supabase",
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  explorerTxUrl: (import.meta.env.VITE_EXPLORER_TX_URL as string | undefined) ?? "https://sepolia.basescan.org/tx/",
};
