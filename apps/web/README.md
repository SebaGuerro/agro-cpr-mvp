# @agro-cpr/web: front-end (Prompt 4)

The single-page app for the six roles: producer, warehouse, financier, insurer, buyer and admin. The screens are in Portuguese; the API keeps its English codes, and `src/lib/labels.ts` translates them.

**Status:** typechecks and builds. Tested by hand in a browser against the local API and seed, on desktop and phone sizes:
- harvest plan, truck dispatch, arrival, classification, disbursement and claim settlement
- import validate, apply and undo
- the admin screens

There are no automated UI tests yet. **Not tested:** Supabase login, uploading a real file from a phone, and a Vercel deploy.

## Locked choices

| Area | Choice | Alternatives considered |
|---|---|---|
| Framework | Vite + React 19 single-page app, TanStack Router (code-based routes) | Next.js, React Router 7 |
| Components | Mantine 8: forms, pt-BR date pickers, tables, notifications | shadcn/ui + Tailwind, Ant Design |
| API client | openapi-fetch with types generated from `openapi.yaml`, plus TanStack Query | Orval, hand-written fetch + Zod |
| Hosting | Vercel | Cloudflare Pages, Fly.io |

Every event form builds a canonical event, checks it against the shared Zod schema (`@agro-cpr/spec`) before sending, and gives it a fresh UUIDv7. That id is the idempotency key, so a double click can't record an event twice.

## Run it locally

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
npm run dev -w @agro-cpr/web
```

The API must run with `AUTH_MODE=dev` and `CORS_ORIGINS=http://localhost:3000`. In dev mode, the login screen lists the seeded users, and a user invited from the Users screen signs in with its id.

`scripts/dev-run.mjs api|web` starts either app from the repo root. The API reads `apps/api/.env.local`, which is gitignored.

After changing `openapi.yaml`, regenerate the types:

```bash
npm run gen:api -w @agro-cpr/web
```

## Screens

| Path | Who | What |
|---|---|---|
| `/login` | all | Dev user picker, or Supabase email + password / magic link |
| `/produtor` | producer, admin | Farms, plots and cycles; new farm, plot (`PLOT_REGISTERED`) and cycle with a preview of potential and eligible volume |
| `/despacho` | producer | **Phone-first** truck dispatch |
| `/talhoes/:id` | all who see the plot | Plot data, soil analyses with lab-report upload, cycles, plot timeline |
| `/ciclos` | all | Cycles visible to the role, filtered by stage and risk |
| `/ciclos/:id` | all | **Main screen.** Volumes, CPR, delivery, risk with its reasons, alerts, trucks, insurance, and the timeline with on-chain status. The role's action buttons open forms |
| `/carteira` | financier, admin | Portfolio totals, CPR requests to approve or reject, cycles with a CPR |
| `/chegadas` | warehouse, admin | **Phone-first** truck cards: arrival, then classification with the discount suggested from the table |
| `/seguros` | insurer, admin | Open claims to settle, policies, linked cycles |
| `/alertas` | all | Open or all alerts; acknowledge |
| `/importacoes` | producer, warehouse, admin | Template download, upload, dry-run result, apply, annotated error file, undo with countdown |
| `/configuracoes` | admin | Haircuts, planting windows, discount tables, input checklists |
| `/usuarios` | admin | Organizations and users; invite (Supabase sends the email) |

**Forms on the cycle screen, by role:**
- **Producer:** planting (warns when outside the planting window), input application (evidence required, checklist item), harvest plan, harvest start, truck dispatch, CPR request (capped at eligible), link insurer, report a claim.
- **Financier:** approve or reject a request, disbursement, information request, settlement.
- **Warehouse:** arrival, classification, CDA/WA, grain release.
- **Buyer:** sale.
- **Insurer:** issue a policy, settle a claim.
- **Original organization or admin:** correct an event. **Admin only:** void an event.

## Deploy on Vercel

1. Import the repo in Vercel and set **Root Directory** to `apps/web`. Vercel detects the npm workspaces and installs from the repo root. `vercel.json` sets the build and the single-page-app rewrite.
2. Set the environment variables:
   - `VITE_API_URL`: the Fly URL
   - `VITE_AUTH_MODE=supabase`
   - `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`: the anon key, never the service role key
   - `VITE_EXPLORER_TX_URL`
3. Add the Vercel URL to the API's `CORS_ORIGINS`, and to Supabase Auth's redirect URLs (for magic links and invites).

Every branch gets a preview URL. Each preview needs its own origin in `CORS_ORIGINS`, or add a wildcard on purpose.

## Known limits

- The bundle is about 290 KB gzipped, in one chunk. Split it by route if load time matters on rural connections.
- Truck lists on the cycle screen are rebuilt from the timeline: voided events are dropped, but corrections to a dispatch aren't applied there. The backend's numbers (delivered, % fulfilled) are always correct.
- A buyer only sees a cycle after grain is released or a sale is recorded for it, so the first sale is entered by the admin (open question 5 in the spec).
- Explorer links only appear for Base Sepolia anchors (chain 84532), not for the local mock chain.
- Dates and times are São Paulo local time (UTC−3).
