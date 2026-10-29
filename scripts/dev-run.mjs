// Starts the API or the web app, or resets the demo data, from the repo root whatever the
// caller's working directory.
//   node scripts/dev-run.mjs api              API with apps/api/.env.local
//   node scripts/dev-run.mjs web              web app on http://localhost:3000
//   node scripts/dev-run.mjs reset [envfile]  demo reset (default apps/api/.env.local;
//                                             apps/api/.env.demo for the hosted database)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [which, envFile = "apps/api/.env.local"] = process.argv.slice(2);
const commands = {
  api: [`--env-file=${envFile}`, "--import", "tsx", "apps/api/src/main.ts"],
  web: ["node_modules/vite/bin/vite.js", "apps/web", "--port", "3000", "--strictPort"],
  reset: [`--env-file=${envFile}`, "--import", "tsx", "apps/api/src/demo/reset.ts", "--yes"],
};
if (!commands[which]) {
  console.error("Usage: node scripts/dev-run.mjs api|web|reset [envfile]");
  process.exit(1);
}
if (which !== "web" && !existsSync(join(root, envFile))) {
  console.error(`${envFile} not found. Copy apps/api/.env.example to it and adjust.`);
  process.exit(1);
}
const child = spawn(process.execPath, commands[which], { cwd: root, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
