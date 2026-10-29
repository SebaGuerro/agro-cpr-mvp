// Starts the API or the web app from the repo root, whatever the caller's working directory.
// Usage: node scripts/dev-run.mjs api|web
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
const commands = {
  api: ["--env-file=apps/api/.env.local", "--import", "tsx", "apps/api/src/main.ts"],
  web: ["node_modules/vite/bin/vite.js", "apps/web", "--port", "3000", "--strictPort"],
};
if (!commands[which]) {
  console.error("Usage: node scripts/dev-run.mjs api|web");
  process.exit(1);
}
const child = spawn(process.execPath, commands[which], { cwd: root, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
