import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Starts the API (fresh demo data, mock chain, dev logins) and the web app on their own
// ports, so a dev server already running on 3000/3001 is left alone.
const root = fileURLToPath(new URL("..", import.meta.url));
const API_PORT = 3101;
const WEB_PORT = 3100;
const CI = Boolean(process.env.CI);

const apiEnv = {
  NODE_ENV: "test",
  PORT: String(API_PORT),
  DATABASE_URL: "pglite:./apps/api/.data/e2e",
  AUTH_MODE: "dev",
  STORAGE_MODE: "local",
  LOCAL_STORAGE_DIR: "./apps/api/.data/e2e-files",
  CHAIN_MODE: "mock",
  LEDGER_KEY_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e-0001",
  CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
  RUN_WORKER: "true",
};

// Locally the installed Edge is used (no browser download); CI installs Chromium.
const browser = CI ? devices["Desktop Chrome"] : { ...devices["Desktop Edge"], channel: "msedge" };

export default defineConfig({
  testDir: "./tests",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "story", use: { ...browser } },
    // A slowed-down run with video, as a backup recording of the demo (test-results/).
    { name: "record", use: { ...browser, video: "on", launchOptions: { slowMo: 600 } } },
  ],
  webServer: [
    {
      command: "node --import tsx apps/api/src/demo/reset.ts --yes && node --import tsx apps/api/src/main.ts",
      cwd: root,
      url: `http://localhost:${API_PORT}/health`,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `node node_modules/vite/bin/vite.js apps/web --port ${WEB_PORT} --strictPort`,
      cwd: root,
      url: `http://localhost:${WEB_PORT}`,
      env: { VITE_API_URL: `http://localhost:${API_PORT}`, VITE_AUTH_MODE: "dev" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
