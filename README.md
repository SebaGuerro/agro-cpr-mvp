# Agro CPR MVP

Tracks a CPR Física from the plot to settlement, for five organization types: producers, the warehouse, financiers, insurers and buyers. Each step is recorded once, with evidence, and anchored on Base Sepolia. This is a pilot on testnet, with no legal standing as a registered CPR.

| Path | What | Docs |
|---|---|---|
| `packages/spec` | The interface contract: canonical events (Zod), OpenAPI, the contract interface, decisions | [README](packages/spec/README.md) |
| `contracts` | AgroLedger (Foundry): soulbound ERC-721 per CPR plus a hash-chained event log | [README](contracts/README.md) |
| `apps/api` | Fastify API: rules, risk, alerts, CSV/Excel imports, anchoring worker | [README](apps/api/README.md), [imports](apps/api/src/ingestion/README.md) |
| `apps/web` | React app for every role (Portuguese) | [README](apps/web/README.md) |
| `e2e` | Playwright: the whole story, from plot to claim, across roles and on a phone | below |
| `docs` | [Demo script (pt-BR)](docs/DEMO.md), [hosted setup](docs/DEPLOY.md) | |

## Run it locally

You need Node 24 and, for the contracts, Foundry.

```bash
npm install
cp apps/api/.env.example apps/api/.env.local   # local settings: embedded Postgres, mock chain, dev logins
npm run demo:reset                             # fresh demo data
node scripts/dev-run.mjs api                   # http://localhost:3001
node scripts/dev-run.mjs web                   # http://localhost:3000, then pick a demo user
```

## Checks

```bash
npm run typecheck              # spec, API, web, e2e
npm test -w @agro-cpr/api      # rules, imports, API and demo-reset tests (embedded Postgres)
cd contracts && forge test     # contract tests
npm run e2e                    # Playwright story; starts its own API and web app on ports 3100/3101
```

GitHub Actions (`.github/workflows/ci.yml`) runs all of these on every push.

Locally, Playwright uses the installed Microsoft Edge; CI installs Chromium. For a backup video of the demo, run `npx playwright install ffmpeg` once, then `npm run record -w @agro-cpr/e2e`. The videos land in `e2e/test-results/`.
