import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

export interface FileStorage {
  put(path: string, data: Buffer, contentType: string): Promise<void>;
  /** A short-lived URL to read the file. */
  url(path: string): Promise<string>;
}

export function supabaseStorage(url: string, serviceRoleKey: string, bucket: string): FileStorage {
  const client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  return {
    async put(path, data, contentType) {
      const { error } = await client.storage.from(bucket).upload(path, data, { contentType, upsert: true });
      if (error) throw new Error(`Storage upload failed: ${error.message}`);
    },
    async url(path) {
      const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 600);
      if (error) throw new Error(`Storage URL failed: ${error.message}`);
      return data.signedUrl;
    },
  };
}

export function diskStorage(dir: string): FileStorage {
  const root = resolve(dir);
  return {
    async put(path, data) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    async url(path) {
      return `file://${join(root, path)}`;
    },
  };
}

export function memoryStorage(): FileStorage & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(path, data) {
      files.set(path, data);
    },
    async url(path) {
      return `memory://${path}`;
    },
  };
}
