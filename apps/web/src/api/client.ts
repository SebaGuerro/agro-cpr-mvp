import createClient from "openapi-fetch";
import { env } from "../lib/env";
import type { paths } from "./schema";

/** RFC 9457 problem returned by the API, thrown so React Query sees it as an error. */
export class ApiProblem extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly errors: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

let getToken: () => string | null = () => null;
export function setTokenSource(fn: () => string | null) {
  getToken = fn;
}

export const api = createClient<paths>({ baseUrl: env.apiUrl });
api.use({
  onRequest({ request }) {
    const token = getToken();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
});

function toProblem(body: unknown, status: number): ApiProblem {
  const b = (body ?? {}) as { code?: string; detail?: string; title?: string; errors?: { path: string; message: string }[] };
  return new ApiProblem(b.code ?? `HTTP_${status}`, b.detail ?? b.title ?? `Erro ${status}`, status, b.errors ?? []);
}

/** Unwraps an openapi-fetch result: returns data or throws ApiProblem. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (!response.ok || error !== undefined) throw toProblem(error, response.status);
  return data as T;
}

/** For multipart uploads and file downloads, which the typed client doesn't cover well. */
export async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${env.apiUrl}${path}`, { ...init, headers });
  if (!res.ok) throw toProblem(await res.json().catch(() => null), res.status);
  return res;
}

export async function uploadFile(file: File): Promise<{ sha256: string; fileName: string | null }> {
  const form = new FormData();
  form.append("file", file);
  return (await rawFetch("/v1/files", { method: "POST", body: form })).json();
}

export async function downloadFile(path: string, fallbackName: string) {
  const res = await rawFetch(path);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
