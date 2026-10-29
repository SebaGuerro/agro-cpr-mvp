# AgroLedger contracts (Prompt 1)

A single contract implementing [`IAgroLedger`](../packages/spec/contracts/IAgroLedger.sol): a soulbound ERC-721 per CPR plus an append-only event log with a hash chain per subject.

**Status:** builds with Foundry 1.8.6 (solc 0.8.24, via-IR) and all 23 tests pass, including 1,000 fuzz runs of the volume cap. Not yet deployed. `forge build` prints lint warnings for reverts inside the batch loop (intended: batches are all-or-nothing) and for the `block.timestamp` comparison (intended: a loose 1-hour clock-skew guard).

## Locked choices for this block

| Area | Choice | Alternatives considered |
|---|---|---|
| Toolchain | Foundry, solc 0.8.24, via-IR | Hardhat, Remix |
| Relayer key | Plain EOA in the backend's secret store | Coinbase CDP server wallet, cloud KMS |
| Admin | 2-of-3 Safe on Base Sepolia | Single admin EOA, hardware-wallet EOA |
| RPC | Alchemy | Public Base RPC, QuickNode |

## Setup and commands

```bash
# once, at the repo root (agro-cpr-mvp)
git init
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0

forge build
forge test -vv
forge coverage
```

Deploy to Base Sepolia:

1. Create a 2-of-3 Safe on Base Sepolia at app.safe.global, with one signer per team member.
2. Create the relayer key with `cast wallet new`. Put its private key in the backend's secret store only, and its address in `.env`.
3. Import a deployer key with `cast wallet import deployer --interactive`, then fund it and the relayer from a Base Sepolia faucet.
4. Fill in `.env` from `.env.example` and load it: `set -a; source .env; set +a`.
5. `forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify`

The deployer gets no role. Only the Safe can grant or revoke roles and pause.

## Design rationale

1. **ERC-721 over ERC-20.** A CPR must be unique and non-fungible; an ERC-721 also shows up as a token on block explorers, which helps the demo.
2. **Soulbound.** Transfers and approvals revert, because CPR transfer (endosso) is a legal act the pilot does not model. Tokens are minted to a custody address (the Safe by default); this ownership has no legal meaning (verify with counsel).
3. **Uniqueness per (plot, season)** comes from `tokenId = uint256(keccak256(abi.encode(plotKey, seasonKey)))`, so a second CPR on the same land and season reverts, whoever the producer is.
4. **Cap on-chain.** `issuedKg <= eligibleKg` is enforced by the contract. The haircut calculation stays in the backend.
5. **Hash chain per subject:** `head = keccak256(abi.encode(previousHead, recordHash))`. Anyone holding the Postgres records can recompute the chain and prove nothing was edited, removed or reordered.
6. **Minimal trust in the contract.** Only the relayer writes. The state machine and per-actor authorization live in the backend. The contract proves *what was recorded and when*, not that it is true.
7. **CPR issuance and settlement are atomic with their events.** Codes 3 and 16 can only go through `issueCpr` and `settleCpr`.
8. **Corrections need an anchored reference on the same subject**, so the relayer must anchor events in order.
9. **No proxy.** If the contract has a bug, deploy a new one and re-anchor from Postgres, which is the source of truth.
10. **No receiver callbacks** (`_mint`, not `_safeMint`) and no external calls, so there is no reentrancy surface.

## Storage

| Mapping | Key → value | Purpose |
|---|---|---|
| `_cprs` | tokenId → `Cpr` | CPR status, volumes, due date, hash of the issuing record |
| `_heads` | subjectKey → `(seq, head)` | Per-subject sequence and hash-chain head |
| `_subjectOf` | eventId → subjectKey | Idempotency (`isRecorded`) and the same-subject check for corrections |

## Interface summary for the backend

| Function | Who | Reverts with |
|---|---|---|
| `issueCpr(CprInput, EventInput) → tokenId` | relayer | `CprAlreadyExists`, `IssuedAboveEligible`, `EventTypeMismatch`, `EventSubjectMismatch`, `InvalidEventInput`, `EventAlreadyRecorded` |
| `settleCpr(tokenId, EventInput)` | relayer | `CprNotIssued`, `EventTypeMismatch`, `EventSubjectMismatch`, `InvalidEventInput`, `EventAlreadyRecorded` |
| `recordEvent(EventInput)` | relayer | `ReservedEventType`, `InvalidEventInput`, `EventSubjectMismatch`, `EventAlreadyRecorded` |
| `recordEvents(EventInput[])` (max 50, all or nothing) | relayer | the above, plus `EmptyBatch`, `BatchTooLarge` |
| `pause()`, `unpause()`, `grantRole`, `revokeRole` | Safe | `AccessControlUnauthorizedAccount` |
| `cycleKeyFor`, `cprOf`, `headOf`, `isRecorded` | anyone | none |

All writes also revert with `EnforcedPause` while paused, and with `AccessControlUnauthorizedAccount` for the wrong caller.

`InvalidEventInput` covers: zero subject/event id/record hash/occurredAt, an unknown event type, `occurredAt` more than 1 hour in the future, a quantity with `Unit.None`, a `refEventId` on a non-correction (or a correction without one), a reference that isn't anchored yet, and a CPR event whose quantity differs from `issuedKg`.

Events emitted: `EventRecorded` for every event, `CprIssued`, `CprSettled`, and the standard ERC-721 `Transfer` on mint.

## Notes for the relayer (Person B)

- **One worker, one nonce.** Use a single pg-boss worker (concurrency 1) for the relayer key, so transactions never race on the nonce.
- **Order matters.** Anchor events in `recordedAt` order per subject. A correction must wait until its referenced event is `ANCHORED`.
- **Idempotency.** Before resending after a timeout, check `isRecorded(eventId)`. `EventAlreadyRecorded` on a retry means the first attempt succeeded: mark the event `ANCHORED`; don't treat it as a failure.
- **Reconciliation.** The job compares `headOf(subjectKey)` with the hash chain recomputed from Postgres. A mismatch means a bug or a compromised key: raise `ANCHOR_FAILED` and page the team.
- **Batching.** Use `recordEvents` for CSV imports, in chunks of up to 50 per subject order.
- **Gas.** Alert when the relayer balance drops below about 0.01 test ETH. Events stay `PENDING` meanwhile; nothing is lost.
- **CPR corrections.** Correcting a `CPR_ISSUED` event changes the off-chain record only. On-chain `issuedKg` can't change. If it's wrong, settle or void off-chain and redo the cycle; this is rare and admin-only.

## Threat model

| # | Risk | Impact | Mitigation in the pilot |
|---|---|---|---|
| 1 | Relayer key leaks | Attacker anchors fake events or CPRs | Key only in the secret store with a small balance; the Safe can pause and `revokeRole`; reconciliation flags on-chain events with no DB row |
| 2 | Backend bug or compromise writes false data | The chain faithfully anchors false facts | Audit log with `recordedBy`, evidence hashes, human review of CPR issuance. The chain is tamper-evident, not a truth oracle |
| 3 | The same land registered as two plots | Double pledge goes undetected | Backend rejects a CAR code already registered by a different producer (`LAND_ALREADY_REGISTERED`); polygon-overlap check (PostGIS) after the MVP |
| 4 | Public chain shows volumes, dates and activity per pseudonymous key | Commercial information about producers leaks, even without names | Testnet pilot with test data; before mainnet, choose between dropping quantities on-chain and a permissioned chain (LGPD: verify with counsel) |
| 5 | `LEDGER_KEY_SECRET` leaks together with the database | On-chain keys can be linked to internal IDs | Keep the secret outside the DB; keys come from UUIDs, never CPF/CNPJ |
| 6 | Safe signers lost, or two collude | Can't pause or revoke, or admin abuse | 2-of-3 across different people; record the signers' addresses in the runbook |
| 7 | Relayer sends events out of order or twice | Corrections revert; duplicate attempts | Single nonce worker, ordered queue, `isRecorded` check before resend |
| 8 | Contract bug found after deployment | Anchoring stops or is wrong | Pause, deploy a new contract, re-anchor from Postgres; keep the old address in history |
| 9 | Test ETH runs out | Anchoring stalls | Balance alert; events queue as `PENDING` |

## Before mainnet or real legal use

- Legal review: CPR registration with an authorized registry (B3, CERC or equivalent), whether an on-chain record has any legal standing, and endorsement (endosso). Verify with counsel.
- Move the relayer key to KMS or a managed wallet, and put the admin Safe signers on hardware wallets.
- Decide what may be public: drop quantities from `EventRecorded` or use a permissioned chain.
- Get an external audit, and settle an upgrade or migration policy.
- Commit to a long-term HMAC secret, since rotating it changes every key.

## 2-day plan for Person A

| When | Task | Done when |
|---|---|---|
| Day 1 a.m. | Install Foundry, `forge install`, fix any compile errors | `forge build` passes |
| Day 1 p.m. | Get the tests green; add tests for anything you changed | `forge test` and `forge coverage` > 95% lines |
| Day 1 end | Create the Safe, create the relayer and deployer keys, deploy and verify on Base Sepolia | Contract verified on Basescan; Safe holds the admin role |
| Day 2 | Pair with B on the relayer: viem client, `EventInput` encoding from `packages/spec`, nonce worker, `isRecorded` and `headOf` reconciliation | One seeded CPR anchored end to end, visible on the explorer |

**Cut line if behind:** skip explorer verification and coverage, and keep only the happy-path, duplicate-CPR, cap, access and soulbound tests. Never cut the duplicate-CPR or cap tests, because they prove the pilot's main claim.
