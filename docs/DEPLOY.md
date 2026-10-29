# Hosted setup for the demo

The order matters: each step needs something from the one before. Allow about **half a day** with 2 people. Everything fits in free tiers; Fly asks for a card.

| # | Step | Who | Time | You end up with |
|---|---|---|---|---|
| 1 | GitHub repo and CI | anyone | 15 min | CI running on every push |
| 2 | Base Sepolia: Safe, keys, contract | Person A | 1.5 h | `AGRO_LEDGER_ADDRESS`, relayer key |
| 3 | Supabase | Person B | 30 min | Database URL, auth and storage keys |
| 4 | Fly (API) | Person B | 30 min | `https://agro-cpr-api.fly.dev` |
| 5 | Demo data | Person B | 15 min | Seeded story, anchoring on Base Sepolia |
| 6 | Users | Person C | 20 min | One login per role |
| 7 | Vercel (web) | Person C | 15 min | The app URL |
| 8 | Smoke test and rehearsal | all | 1 h | Confidence |

Keep secrets in a password manager, never in the repo or in chat. The `.gitignore` already excludes `.env` and `.env.*` (except `.env.example`).

## 1. GitHub repo and CI

1. Create a **private** repo named `agro-cpr-mvp` (no README, so the history stays clean).
2. Push:
   ```bash
   git remote add origin git@github.com:<org>/agro-cpr-mvp.git
   git push -u origin main
   ```
3. Under Actions, the **CI** workflow runs four things:
   - typecheck
   - API tests
   - web build
   - Foundry tests, plus the Playwright story

   The first run takes about 6 minutes.

If `npm ci` fails on a missing `@rollup/rollup-linux-*` or `@esbuild/linux-*` package, the lockfile was made on Windows. Run `npm install` once on Linux or macOS (or in a Codespace), commit `package-lock.json`, and push again.

## 2. Base Sepolia: Safe, keys and contract (Person A)

Follow `contracts/README.md` › "Deploy to Base Sepolia". In short:

1. **Alchemy:** create an app on Base Sepolia and copy the RPC URL.
2. **Safe:** at app.safe.global, create a 2-of-3 Safe on Base Sepolia, with one signer per team member.
3. **Relayer key:** generate it with `cast wallet new`.
   - The private key goes only into Fly (step 4); the address goes into `contracts/.env`.
4. **Deployer key:** import it with `cast wallet import deployer --interactive`.
5. **Test ETH:** get it from a Base Sepolia faucet (Coinbase Developer Platform or Alchemy).
   - deployer: about 0.02 ETH
   - relayer: about 0.05 ETH, which covers several demo resets of about 40 events each
6. **Deploy:**
   ```bash
   cd contracts
   set -a; source .env; set +a
   forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify
   ```
7. Write down the contract address, and check on Basescan that the Safe holds the admin role and the relayer holds `RELAYER_ROLE`.

## 3. Supabase (Person B)

1. Create a project in the **South America (São Paulo)** region.
2. **Storage:** create a **private** bucket named `evidence`.
3. **Auth:** enable email (password and magic link). Fill in the Site URL and redirect URLs after step 7.
4. **Copy these values:**

   | Value | Where it goes |
   |---|---|
   | Project URL | `SUPABASE_URL` and `VITE_SUPABASE_URL` |
   | `anon` key | `VITE_SUPABASE_ANON_KEY` (web only) |
   | `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` (API only, **never** in the web app) |
   | **Session pooler** connection string, port **5432** | `DATABASE_URL`. pg-boss needs session features that the transaction pooler (6543) doesn't support |

## 4. Fly: the API (Person B)

```bash
fly auth login
fly apps create agro-cpr-api
fly secrets set -c apps/api/fly.toml \
  DATABASE_URL='postgresql://…:5432/postgres' \
  SUPABASE_URL='https://<ref>.supabase.co' \
  SUPABASE_SERVICE_ROLE_KEY='…' \
  LEDGER_KEY_SECRET="$(openssl rand -hex 32)" \
  BASE_SEPOLIA_RPC_URL='https://base-sepolia.g.alchemy.com/v2/…' \
  RELAYER_PRIVATE_KEY='0x…' \
  AGRO_LEDGER_ADDRESS='0x…' \
  CORS_ORIGINS='https://<vercel-app>.vercel.app' \
  IMPORT_HOLD_MINUTES=30
fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile
curl https://agro-cpr-api.fly.dev/health
```

- The release command runs the database migrations.
- `fly.toml` already sets `CHAIN_MODE=base-sepolia`, `AUTH_MODE=supabase` and `STORAGE_MODE=supabase`.
- **Save the `LEDGER_KEY_SECRET` value in the password manager.** Step 5 needs the same value, and it must never change during the pilot: every on-chain key is derived from it.
- The Docker image isn't built in CI. If `fly deploy` fails at `npm ci`, see the lockfile note in step 1.

## 5. Demo data (Person B, from a laptop)

Create `apps/api/.env.demo`. It's gitignored, so it stays on your laptop.

```bash
NODE_ENV=production
DATABASE_URL=postgresql://…:5432/postgres
AUTH_MODE=supabase
SUPABASE_URL=https://<ref>.supabase.co
CHAIN_MODE=base-sepolia
BASE_SEPOLIA_RPC_URL=https://base-sepolia.g.alchemy.com/v2/…
RELAYER_PRIVATE_KEY=0x…
AGRO_LEDGER_ADDRESS=0x…
LEDGER_KEY_SECRET=<the same value as on Fly>
```

Then run the reset:

```bash
node scripts/dev-run.mjs reset apps/api/.env.demo
```

- The reset only writes to the database. The Fly worker anchors the ~40 seeded events within 2–5 minutes.
- Check the contract's event list on Basescan.
- Each reset creates new plot and CPR ids, because the previous ones are already on-chain. Organizations and users are kept.

## 6. Users (Person C)

1. **First admin:** in Supabase, go to Authentication › Users › Add user (email and password) and copy the user id. Then, in the SQL editor:
   ```sql
   insert into memberships (user_id, org_id, role, email, name)
   values ('<auth user id>', '00000000-0000-4000-8000-000000000101', 'ADMIN', '<email>', '<name>');
   ```
2. Sign in to the app as that admin. Under **Usuários e organizações › Convidar usuário**, invite one person per role into the seeded organizations:

   | Organization | Role | Used in the demo for |
   |---|---|---|
   | Sítio Santa Rita | Producer (PR) | Truck dispatch on the phone |
   | Fazenda Boa Vista | Producer (MT) | New cycle and CPR request |
   | Armazém Central | Warehouse | Arrival and classification on the phone |
   | Securitizadora Campo | Financier | Portfolio, approval, settlement |
   | Seguradora Safra Segura | Insurer | Claim |
   | Trading Grão Forte | Buyer | Optional |

3. Each person opens the invitation email and sets a password.

## 7. Vercel: the web app (Person C)

1. **New Project:** import the repo, and set **Root Directory** to `apps/web`.
2. **Environment variables:**

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | `https://agro-cpr-api.fly.dev` |
   | `VITE_AUTH_MODE` | `supabase` |
   | `VITE_SUPABASE_URL` | the Supabase project URL |
   | `VITE_SUPABASE_ANON_KEY` | the `anon` key |
   | `VITE_EXPLORER_TX_URL` | `https://sepolia.basescan.org/tx/` |

3. **Deploy**, then:
   - add the Vercel URL to Fly: `fly secrets set -c apps/api/fly.toml CORS_ORIGINS='https://<app>.vercel.app'`
   - set it as Supabase's Site URL and add it to the redirect URLs

## 8. Smoke test and rehearsal

- [ ] The app loads and every role can sign in and sees its home screen.
- [ ] The financier's portfolio shows grades C and D. The timeline shows **Na blockchain**, and the link opens Basescan.
- [ ] Upload an evidence file and record an input application, which checks Storage.
- [ ] Dispatch a truck on the phone, and the warehouse receives it on the phone.
- [ ] Download an import template.
- [ ] Rehearse `docs/DEMO.md` end to end with a stopwatch.
- [ ] Reset: `node scripts/dev-run.mjs reset apps/api/.env.demo`, and wait for anchoring.

## Not verified before handover

- The Docker image and Fly deploy
- Supabase auth, invites and storage
- The viem adapter against the real contract on Base Sepolia
- The CI workflow on GitHub

All of these were built and unit-tested, but never run against the real services. Expect to fix small configuration issues on the first try.
