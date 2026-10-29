# @agro-cpr/api: backend (Prompts 2 and 3)

The domain API, rules engine, risk scoring, alerts, the CSV and Excel imports (see [`src/ingestion/README.md`](src/ingestion/README.md)), and the relayer that anchors events on AgroLedger. It implements [`openapi.yaml`](../../packages/spec/openapi/openapi.yaml).

**Status:** typechecks, and 72 tests pass:
- 20 rule tests
- 8 parsing tests
- 44 integration tests that run the real app against an embedded Postgres loaded with the seed scenario (22 for the API, 21 for imports, 1 for the demo reset)

A local smoke run (migrate, seed, start, authenticated reads) works. **Not yet tested:** a real Supabase project, a real Base Sepolia contract through the viem adapter, pg-boss on real Postgres, and the Docker image and Fly deploy.

## Locked choices

| Area | Choice | Alternatives considered |
|---|---|---|
| Framework | Fastify 5 | Hono, NestJS |
| DB access | Drizzle (postgres.js; PGlite for dev and tests) | Prisma, Kysely |
| Jobs | pg-boss 10 (PGlite: in-process timers) | BullMQ + Redis, Supabase Queues |
| Hosting | Fly.io, São Paulo (`gru`) | Railway, Render |
| From earlier blocks | TypeScript, REST + OpenAPI, Supabase, Base Sepolia, viem | |

## Run it locally (no Supabase, no chain)

```bash
cp apps/api/.env.example apps/api/.env
npm install
npm run db:migrate -w @agro-cpr/api
npm run seed -w @agro-cpr/api
npm run dev -w @agro-cpr/api
```

The scripts don't load `.env` automatically: export the variables in your shell first, or use a tool like `dotenv-cli`.

`DATABASE_URL=pglite:./.data/pg` runs an embedded Postgres, so nothing else needs installing. Seed prints a dev token for each role: send `Authorization: Bearer dev:<userId>`. `AUTH_MODE=dev` is refused when `NODE_ENV=production`.

```bash
npm test -w @agro-cpr/api
```

## Layout

| Path | What |
|---|---|
| `src/domain/` | Pure rules, no I/O: state machine and replay (`cycleState.ts`), planting windows, checklist, quantities and discounts, findings and risk (`findings.ts`) |
| `src/services/` | Recording events (authorization, validation, persistence), crop cycles and CPR requests, read views and visibility, configs, alert sync |
| `src/routes/` | Fastify routes, one file per area |
| `src/ingestion/` | Spreadsheet parsing, the `IngestionSource` port, import kinds, templates and annotated files |
| `src/chain/` | Ledger keys and `EventInput` encoding, mock chain, viem adapter for Base Sepolia |
| `src/jobs/` | Anchoring sweep, reconciliation, pg-boss and timer runners |
| `src/seed/` | The demo scenario, created through the same services as the API |
| `drizzle/` | SQL migrations (`npm run db:generate` after schema changes) |

## How a write works

1. `POST /v1/events` validates the body against the canonical schema from `packages/spec`.
2. The caller's identity is checked: non-admins act only as their own org and role; an admin acts on behalf of an org of the matching kind. Then the emitter matrix and the per-org rules apply (only the CPR's warehouse can receive grain, and so on).
3. The plot or crop-cycle row is locked, and the subject's whole event stream is replayed with the new event appended. Voids and corrections are applied during the replay, so a correction that breaks a later step is rejected (`CORRECTION_BREAKS_STREAM`).
4. The event is stored with its SHA-256 `recordHash`, and the crop cycle's cached state is updated in the same transaction.
5. Alerts for that cycle are re-synced, and the anchoring worker is woken.

The client generates the event `id`. Resending the same event returns `200` with the stored record; reusing the id with different content returns `409 EVENT_ID_CONFLICT`.

## Anchoring

- The `events` table is the outbox: new rows are `PENDING`.
- The worker sends them one transaction at a time in insertion order. `CPR_ISSUED` and `CPR_SETTLED` go through `issueCpr` and `settleCpr`, everything else through `recordEvent`.
- Before each send it checks `isRecorded`, so a retry after a timeout doesn't double-send.
- A failure blocks only that subject's later events. After 5 attempts it raises a HIGH `ANCHOR_FAILED` alert.
- Every 30 minutes, reconciliation recomputes each subject's hash chain from Postgres and compares it with `headOf` on the contract. A mismatch raises `ANCHOR_FAILED`.
- pg-boss uses the `stately` policy, so a sweep never overlaps another, even if a second machine is added.
- **Imported events wait `IMPORT_HOLD_MINUTES` (default 30)** before anchoring, and so does anything recorded after them on the same subject. That wait is the rollback window for a wrong file.
- **Batching:** one transaction per event is enough for the pilot (about 2 s each on Base). If CSV imports make this slow, switch the worker to `recordEvents` in batches of 50.

## Admin and the front-end

- `GET /v1/orgs` lists organizations (id, name, kind) for pickers.
- `GET/POST /v1/admin/orgs` and `GET/POST /v1/admin/users` (ADMIN) create organizations and invite users. Supabase sends the invitation (needs `SUPABASE_SERVICE_ROLE_KEY`). In `AUTH_MODE=dev` the user gets a random id and signs in with `dev:<id>`. A user's role follows their organization's kind.
- Finding and alert messages are in Portuguese with Brazilian date and number formats, because the screens show them as written. Codes stay in English.

## Insurance

- The producer links an insurer to a crop cycle (`POST /v1/crop-cycles/{id}/insurers`). The insurer then sees that cycle, like a financier with a CPR request.
- The insurer records `POLICY_ISSUED`, the producer `CLAIM_FILED`, and the policy's insurer `CLAIM_SETTLED` (paid or denied).
- An open claim raises a HIGH `CLAIM_OPEN` alert; after 30 days without an answer, also `CLAIM_UNANSWERED`.
- Policies and claims never change the risk grade; the cycle view shows them under `insurance`.
- Insurance events are accepted after the CPR is settled, because a claim can outlive it.

## Risk grade

Every rule that fires produces one finding. Findings feed both the risk grade and the alerts, so the reasons shown always match the alerts raised.

| Dimension | Weight | Findings (points) |
|---|---|---|
| Planting window | 0.4 | outside window 100, window missed 80, no window configured 40 |
| Input compliance | 0.3 | each missing application 35, each late 15, no checklist 20 |
| Harvest and delivery | 0.3 | shortfall after the delivery window 60, harvest overdue 30, truck overdue 25 each, harvest without plan 20, ticket discount mismatch 10 each |

Each dimension caps at 100. Score = max(weighted average, 0.8 × worst dimension), so one severe problem can't be averaged away. Grades: A < 15, B < 35, C < 60, D ≥ 60. The weights are in `RISK_WEIGHTS` (`src/domain/findings.ts`).

## Demo reset

`node scripts/dev-run.mjs reset [envfile]` (or `npm run demo:reset` at the root, which uses `apps/api/.env.local`) removes every farm, plot, cycle, event, alert and import, then seeds again. Organizations and users are kept. On a real chain each reset seeds with fresh ids, because the previous run is already anchored. A test proves two runs anchor side by side on one chain and still reconcile.

## Seed scenario

| Cycle | What it shows |
|---|---|
| PR soybean 2025/26 (Sítio Santa Rita) | CPR of 108 t, 3 trucks delivering 104.6 t net (96.8%, under the 98% tolerance), one fungicide date corrected, one quality ticket that disagrees with the discount table, a sale and a release. Not settled, so it shows a shortfall and an overdue CPR. Grade C |
| MT soybean 2026/27 (Fazenda Boa Vista) | CPR of 1,000 t, planted 5 to 12 September before the sample window opens (16 September), pre-emergence herbicide missing, an open info request from the financier. Insured by Seguradora Safra Segura (multi-peril policy) with an open drought claim. Grade D |

All planting windows, discount tables and checklists in the seed are **samples**, marked `isSample`. Replace them with official ZARC data and your classification tables before real use.

## Deploy (Supabase + Fly.io)

1. **Supabase:** create the project in the South America (São Paulo) region, and create a private Storage bucket named `evidence`. Copy the **session pooler** connection string (port 5432): pg-boss needs session features that the transaction pooler (6543) doesn't support.
2. **Users:** create each person in Supabase Auth, then link them to an org:
   `insert into memberships (user_id, org_id, role, email) values ('<auth user id>', '<org id>', 'FINANCIER', '...')`. Seed data uses fixed demo user ids; don't seed a production database.
3. **Fly:** run `fly apps create agro-cpr-api`, then set the secrets:
   ```bash
   fly secrets set -c apps/api/fly.toml DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... LEDGER_KEY_SECRET=... BASE_SEPOLIA_RPC_URL=... RELAYER_PRIVATE_KEY=... AGRO_LEDGER_ADDRESS=... CORS_ORIGINS=https://<front-end>
   ```
4. Deploy from the repo root. Migrations run as the release command:
   ```bash
   fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile
   ```

**Keep `LEDGER_KEY_SECRET` fixed for the whole pilot.** On-chain keys derive from it, so changing it breaks reconciliation for everything already anchored.

## Known limits (fine for the pilot, revisit after)

- Visibility filtering loads all crop cycles and filters in memory. Move it into SQL past a few thousand cycles.
- List endpoints return everything; `nextCursor` is always `null`.
- The API connects with the database owner role. Supabase row-level security isn't used, so authorization lives entirely in `services/`.
- Alerts are in-app only (no email or WhatsApp yet).
- `GET /v1/config/*` is readable by every role, so the front-end can warn about the planting window before submitting.
