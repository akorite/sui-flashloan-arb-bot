---
title: SUI Cross-DEX Flashloan Arbitrage Bot (v1)
type: feat
status: active
date: 2026-06-07
origin: docs/brainstorms/2026-06-07-sui-flashloan-arbitrage-bot-requirements.md
---

# SUI Cross-DEX Flashloan Arbitrage Bot (v1)

## Summary

A TypeScript, single-process, polling-based arbitrage bot that runs against SUI testnet, detects cross-DEX price spreads between Cetus, Turbos, and Aftermath on SUI/USDC and DEEP/USDC, and submits atomic PTBs (flashloan borrow → swap on cheap DEX → swap on expensive DEX → repay) when the net spread exceeds a fee-aware threshold. v1 is the smallest version that proves the architecture end-to-end and is sized to teach the operator the full SUI arb stack without spending the $10 gas budget.

## Problem Frame

SUI is a newer Move-based chain where retail MEV accessibility is in an early window: less professional searcher density than Ethereum mainnet, but also less liquidity and less documentation. The user is new to MEV/arbitrage and wants to know whether the SUI on-ramp is real or whether the realistic answer is "wait for liquidity and infrastructure to mature." A testnet v1 bot is the truth-telling instrument. See origin document for the full problem framing.

## Requirements

- R1. Poll at least three SUI CLMM DEXes (Cetus, Turbos, Aftermath) for the configured pair list on a cadence no faster than 1s per pair. (origin R1)
- R2. For each poll cycle and pair, compute a slippage-adjusted cross-DEX spread. (origin R2)
- R3. Execute a PTB only when the net spread (gross spread − gas − flashloan fee − slippage safety margin) exceeds the configured minimum edge threshold. (origin R3)
- R4. Each PTB is atomic: `borrow → swap A → swap B → repay` in a single Sui PTB. (origin R4)
- R5. Default flashloan provider is NAVI; Suilend is the documented fallback. (origin R5)
- R6. Never submit a PTB whose swap size exceeds the available liquidity of either target pool; log and skip. (origin R6)
- R7. Log every detection, every submission attempt, and every outcome (success with PnL / revert with reason / submission error). (origin R7)
- R8. Enforce a per-run max on PTB submissions so a misbehaving run cannot exhaust the operator's gas budget. (origin R8)
- R9. v1 monitors SUI/USDC and DEEP/USDC. (origin R9)

**Origin actors:** A1 (Operator), A2 (Bot), A3 (CLMM DEXes), A4 (flashloan provider)
**Origin flows:** F1 (detect-and-execute loop), F2 (insufficient liquidity handling), F3 (operator visibility)
**Origin acceptance examples:** AE1 (covers R1, R2), AE2 (covers R3), AE3 (covers R4), AE4 (covers R6), AE5 (covers R8)

## Scope Boundaries

- No multi-strategy (triangular, liquidations) — see origin scope boundaries; liquidations are a v2 candidate.
- No MEV-aware execution (no mempool scanning, no validator-level capture, no private order flow) — bot submits via public RPC.
- No CEX-DEX arbitrage.
- No production hardening (HA, persistence, alerting, dashboard, multi-account) — v1 is a single-process research tool.
- No mainnet deployment — v1 is testnet-only.
- No historical backtesting — runs in real time only.
- No auto-tuning of the threshold — startup-time configuration only.
- No live integration tests against SUI testnet in CI — testnet-dependent behavior is verified manually per the origin's success criteria.

### Deferred to Follow-Up Work

- Add a Suilend flashloan path as a runtime fallback: separate PR, gated on the NAVI integration proving stable.
- Add support for additional pairs beyond SUI/USDC and DEEP/USDC: configuration-only change, deferred until v1 is reviewed.

## Context & Research

### Relevant Code and Patterns

- Greenfield project. No existing code, AGENTS.md, or institutional learnings in the repo at the time of planning. The plan introduces the entire TypeScript project from scratch.

### External References

- Sui TypeScript SDK (`@mysten/sui`) — first-class PTB construction, RPC client, transaction signing.
- Sui RPC public endpoints (testnet) — `https://fullnode.testnet.sui.io:443` and similar.
- NAVI Protocol flashloan (Sui) — flashloan module callable within a PTB.
- Cetus, Turbos, Aftermath CLMM SDKs / swap modules — each exposes a swap function suitable for inclusion in a PTB.

The Sui TS SDK, NAVI's flashloan contract, and the three DEXes' swap modules must be confirmed against current package IDs and function signatures at implementation time. The plan treats them as known primitives whose exact addresses are discovery-time concerns.

## Key Technical Decisions

- **Single TypeScript process, no task queue or service mesh.** v1 is small enough that a long-running loop is the simplest model and the easiest to inspect via logs. Decoupling the poller from the executor (e.g., a queue between them) is an unnecessary carrying cost for v1.
- **Pool-state abstraction over the three DEXes via a small `DexClient` interface.** Each DEX has different query and swap shapes, but the bot only needs three things: read mid-price, quote a swap at a given size, and execute a swap. The interface narrows the rest of the code to "any DEX with these three operations," which keeps the detector and PTB builder DEX-agnostic.
- **Slippage estimated from pool depth in the detector, with a configurable safety margin added on top.** Real Sui CLMMs expose pool reserves; quoting is a deterministic computation against the CLMM formula. The plan uses that for the size that maximizes the spread minus expected price impact, then layers a configurable safety margin so the actual on-chain execution has slack for state changes between quote and submit.
- **PTB composed with the Sui TS SDK's `Transaction` builder, with NAVI's flashloan as the first moveCall.** The SDK's PTB API natively supports composing heterogeneous calls; the bot's job is to build the call sequence, simulate it locally, and submit. NAVI's flashloan function takes a `receipt` hot potato that must be consumed in the same PTB by either repayment or settlement — this is the architectural anchor of R4.
- **Polling cadence driven by a single timer, not per-DEX timers.** Three DEXes × two pairs × 1s cadence is the upper bound; a single tick loop is simpler and avoids drift between DEXes.
- **Structured JSON-line logging to stdout.** A single configurable logger; no log file rotation, no remote log shipping. Operator can pipe to a file or `tee` if they want persistence.
- **Vitest as the test framework.** Vitest is the conventional choice for TypeScript in 2026; fast, ESM-native, simple config. Tests cover the detector and threshold gate (deterministic, mockable). Live testnet execution is verified by running the bot and reading logs.

## Open Questions

### Resolved During Planning

- **Polling cadence default:** 1s per pair, configurable upward. Resolved: 1s matches the "no faster than 1s" requirement in R1 and is well within public RPC rate limits.
- **Threshold default:** a non-zero minimum edge (e.g., 50 bps) expressed as a percentage of trade size, configurable. Resolved: a default of `0` is dangerous on mainnet later; a small non-zero default makes the bot's behavior on testnet "no PTBs submitted" until the operator tunes it up, which is safer.
- **Run target:** local Node.js process. Resolved: matches the origin's "single-process research tool" framing.
- **Configuration format:** a single `config.json` at the project root, loaded at startup. Resolved: simplest format that the operator can hand-edit; no need for a richer config language in v1.

### Deferred to Implementation

- **Sui TS SDK PTB composition API and `borrow → swap → swap → repay` sequencing.** Implementation-time; depends on the SDK version pinned in `package.json`.
- **NAVI flashloan function signature, fee structure, and package ID on Sui testnet.** Implementation-time; planner flagged this as unverified in origin; implementer should look it up against the current NAVI contracts.
- **Cetus, Turbos, Aftermath public RPC endpoints and pool-state query shape.** Implementation-time; discover the working endpoints and query patterns.
- **Default pair addresses and pool IDs for SUI/USDC and DEEP/USDC.** Implementation-time; lookup at startup or hardcode the most liquid pool per pair.

## Output Structure

    ./
    AGENTS.md                         # scratch — not part of v1, ignored if pre-existing
    package.json
    tsconfig.json
    vitest.config.ts
    config.example.json               # example config the operator copies to config.json
    src/
      index.ts                        # process entry point — wires the bot loop
      config.ts                       # config loader + validation
      logger.ts                       # structured JSON-line logger
      dex/
        types.ts                      # DexClient interface + PoolState / Quote types
        cetus.ts                      # Cetus client implementation
        turbos.ts                     # Turbos client implementation
        aftermath.ts                  # Aftermath client implementation
        index.ts                      # factory: builds the three clients from config
      detector/
        spread.ts                     # spread calculation + slippage-adjusted quote comparison
        threshold.ts                  # net-spread gate (R3)
        opportunity.ts                # type describing a single detected opportunity
      ptb/
        builder.ts                    # PTB construction (R4) — composes borrow/swap/repay
        navi.ts                       # NAVI flashloan integration (R5)
        submit.ts                     # signs and submits a constructed PTB
      bot/
        loop.ts                       # the main loop — pulls state, runs detector, runs PTB on hit
        safety.ts                     # max-submissions cap (R8)
        liquidity.ts                  # liquidity-cap handling (R6)
    test/
      detector/
        spread.test.ts
        threshold.test.ts
      ptb/
        builder.test.ts
      bot/
        safety.test.ts
        liquidity.test.ts
    docs/
      brainstorms/
        2026-06-07-sui-flashloan-arbitrage-bot-requirements.md
      plans/
        2026-06-07-001-feat-sui-flashloan-arb-bot-plan.md

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    participant Loop as Bot Loop (bot/loop.ts)
    participant Dex as DexClient × 3 (dex/)
    participant Det as Detector (detector/)
    participant Build as PTB Builder (ptb/)
    participant Navi as NAVI Flashloan
    participant Chain as SUI Testnet RPC

    Loop->>Dex: pollState([SUI/USDC, DEEP/USDC])
    Dex-->>Loop: PoolState[] (price, reserves)
    Loop->>Det: findOpportunities(states)
    Det->>Det: for each pair, compute cross-DEX spread
    Det->>Det: for each spread, check net > threshold
    Det-->>Loop: Opportunity[] (or empty)
    Loop->>Det: getOptimalSize(opportunity)
    Det->>Dex: quote(opportunity, size)
    Dex-->>Det: expectedOut
    Det-->>Loop: sizedOpportunity
    Loop->>Build: build(sizedOpportunity)
    Build->>Navi: borrow(asset, amount) -> receipt
    Build->>Dex: swap(cheaperDex, asset, amount)
    Build->>Dex: swap(expensiveDex, asset, expectedOut)
    Build->>Navi: repay(receipt, fee)
    Build-->>Loop: PTB (transaction bytes)
    Loop->>Chain: submit(PTB)
    Chain-->>Loop: result (success / revert / error)
    Loop->>Loop: log + decrement safety cap
```

The hot path is the loop; the PTB is the unit of capital action; the chain is the only network dependency. Everything else is in-process.

## Implementation Units

### U1. Project Scaffolding and Configuration

**Goal:** Stand up a runnable TypeScript project with the Sui SDK, a config loader, a structured logger, and an entry point that exits cleanly.

**Requirements:** R7 (logging foundation), R8 (configurable safety cap needs a config to come from somewhere), R9 (pair list lives in config)

**Dependencies:** None

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `config.example.json`
- Create: `src/index.ts`
- Create: `src/config.ts`
- Create: `src/logger.ts`
- Test: `test/logger.test.ts`

**Approach:**
- `package.json` declares `@mysten/sui` as the runtime dependency and `vitest` as the dev dependency; uses `tsx` for local execution and `tsc --noEmit` for type-check. `npm run dev` runs the bot; `npm test` runs vitest.
- `config.example.json` is committed; the real `config.json` is git-ignored and copied from the example by the operator. The example documents every key.
- `src/config.ts` validates required keys (`rpcUrl`, `pairs`, `dexes`, `threshold`, `maxSubmissions`, `pollIntervalMs`) and exits with a clear error message if any are missing or malformed.
- `src/logger.ts` emits one JSON object per line to stdout, with `ts`, `level`, `event`, and event-specific fields. Levels: `info`, `warn`, `error`.
- `src/index.ts` is a thin entry: load config, instantiate logger, hand off to the bot loop (U5).

**Test scenarios:**
- Happy path: logger emits a parseable JSON line with all required fields. Edge case: `config.json` missing a required key returns a non-zero exit code and a specific error string. Error path: malformed `rpcUrl` is rejected by config validation.

**Verification:** `npm run dev` with a valid `config.json` reaches the bot loop (U5) and emits a startup log line. `npm test` runs.

---

### U2. DexClient Interface and Pool State Polling

**Goal:** Provide a uniform way to read pool state and quote a swap from any of the three DEXes, with three concrete implementations.

**Requirements:** R1 (poll three DEXes), R2 (raw data the detector will turn into a spread)

**Dependencies:** U1

**Files:**
- Create: `src/dex/types.ts`
- Create: `src/dex/cetus.ts`
- Create: `src/dex/turbos.ts`
- Create: `src/dex/aftermath.ts`
- Create: `src/dex/index.ts`
- Test: `test/dex/poll.test.ts` (with mocked RPC)

**Approach:**
- `types.ts` defines `DexClient` with two methods: `getPoolState(pair: Pair): Promise<PoolState>` and `quoteSwap(pair: Pair, size: bigint): Promise<Quote>`. `PoolState` carries reserves for both sides of the pair plus the current tick/sqrt-price; `Quote` carries expected output and the price impact percentage.
- Each of `cetus.ts`, `turbos.ts`, `aftermath.ts` is a thin adapter. They may pull from the DEX's own SDK if one exists, or use raw Sui RPC reads of the relevant pool objects when an SDK is not available. The adapter hides the difference.
- `dex/index.ts` exposes a `buildDexClients(config, suiClient)` factory that returns a record keyed by DEX name.
- The bot's call site is "ask each client for state, then quote each opportunity." Everything below the interface is DEX-specific.

**Test scenarios:**
- Happy path: with a mocked RPC, `getPoolState` returns a valid `PoolState` for a known pair. Edge case: a pair that doesn't exist on a given DEX returns a specific `PairNotFound` error, not a generic exception. Error path: RPC timeout surfaces as a typed error the bot can log and skip, not a process crash.

**Verification:** A `npm run dev` startup with a real (or testnet-mocked) RPC prints a "polling" log line on the configured cadence.

---

### U3. Spread Detector and Threshold Gate

**Goal:** Given a set of pool states for one pair, identify the best cross-DEX opportunity and decide whether it's worth executing.

**Requirements:** R2 (slippage-adjusted spread), R3 (net-spread gate)

**Dependencies:** U2

**Files:**
- Create: `src/detector/spread.ts`
- Create: `src/detector/threshold.ts`
- Create: `src/detector/opportunity.ts`
- Test: `test/detector/spread.test.ts`
- Test: `test/detector/threshold.test.ts`

**Approach:**
- `opportunity.ts` defines the `Opportunity` type: which pair, which DEX to buy on, which to sell on, the gross spread, the optimal trade size, the estimated slippage at that size, the estimated gas, the flashloan fee, and the net spread.
- `spread.ts` takes the states for one pair across the configured DEXes, sorts by mid-price, and for each (cheap, expensive) pair runs a search over trade sizes via the appropriate `quoteSwap` to find the size that maximizes `(expectedOutExpensive − expectedOutCheaper − fees)`. Returns the best `Opportunity`, or `null` if no candidate pair produces a positive net.
- `threshold.ts` is a single function: `(opportunity: Opportunity) => boolean` returning `true` iff `opportunity.netSpreadBps >= config.thresholdBps`. Pure, easy to test.
- The detector and the gate are pure functions over the `PoolState` / `Opportunity` shapes — easy to unit test without a real RPC.

**Test scenarios:**
- Happy path: three DEXes with known prices, detector finds the best cross-DEX pair and reports a positive opportunity. Edge case: all three DEXes at the same price returns `null`. Edge case: opportunity's net spread is below threshold → gate returns `false`. Error path: a `PoolState` with missing reserves is rejected by the detector with a typed error.

**Verification:** Unit tests cover the canonical cases; a one-off integration check runs the detector against live testnet pool state during the manual verification pass.

---

### U4. PTB Builder and Flashloan Composer

**Goal:** Given an `Opportunity`, build a Sui PTB that atomically borrows from the flashloan provider, swaps on the cheap DEX, swaps on the expensive DEX, and repays the flashloan.

**Requirements:** R4 (atomic pattern), R5 (NAVI default)

**Dependencies:** U2 (DexClient.quoteSwap output informs the size), U3 (Opportunity is the input)

**Files:**
- Create: `src/ptb/navi.ts`
- Create: `src/ptb/builder.ts`
- Create: `src/ptb/submit.ts`
- Test: `test/ptb/builder.test.ts`

**Approach:**
- `navi.ts` wraps NAVI's flashloan call as a typed helper: `borrowFlashloan(tx, asset, amount) -> receipt` and `repayFlashloan(tx, receipt, asset, amount + fee)`. The receipt hot potato is the architectural anchor: the PTB cannot be valid unless it is consumed in the same transaction.
- `builder.ts` constructs a `Transaction` with the SDK's PTB API, wires the four operations in order, and returns the transaction bytes. The exact call sequence for the swaps depends on the DEX-specific adapter; the builder pulls in the right one based on `opportunity.buyDex` and `opportunity.sellDex`.
- `submit.ts` signs the transaction with a keypair loaded from `config.privateKey` (or a separate env var — see deferred question) and submits it to `config.rpcUrl`, returning a structured result: `{ status: 'success' | 'revert' | 'error', digest, gasUsed, error? }`.
- The test mocks the SDK and asserts the call sequence: borrow first, repay last, with the two swaps in between. It does not need a live chain.

**Test scenarios:**
- Happy path: builder emits exactly the four operations in the correct order against a fake SDK. Edge case: missing opportunity fields produce a build-time error, not a runtime crash. Integration: a single test composes a full PTB for a hand-rolled opportunity and confirms the SDK accepts it (no `invalidPTB` error from the SDK). Error path: NAVI borrow reverts are surfaced as typed errors the bot logs.

**Verification:** Unit tests cover the build sequence. Manual verification: on testnet, the operator manually triggers a PTB build for a known opportunity and inspects the resulting transaction bytes.

---

### U5. Bot Loop, Safety, and Liquidity Handling

**Goal:** Tie the detector, builder, and submit into a single long-running loop, with per-run max submissions, liquidity-cap handling, and the logging discipline.

**Requirements:** R6 (no swap beyond available liquidity), R7 (comprehensive logging), R8 (max submissions cap)

**Dependencies:** U2, U3, U4

**Files:**
- Create: `src/bot/safety.ts`
- Create: `src/bot/liquidity.ts`
- Create: `src/bot/loop.ts`
- Modify: `src/index.ts` (hand off to `loop.run`)
- Test: `test/bot/safety.test.ts`
- Test: `test/bot/liquidity.test.ts`

**Approach:**
- `safety.ts` exposes a `SafetyCap` value object with `canSubmit(): boolean`, `recordAttempt()`, and a `remaining` accessor. On construction it takes `maxSubmissions` from config. The cap is process-local; a fresh process starts fresh.
- `liquidity.ts` exports `liquidityOk(opportunity, poolStates): boolean` — the second pre-submit check beyond the detector's own size optimization. The detector picks the size that maximizes net, but `liquidityOk` enforces a hard ceiling: if the size exceeds either target pool's effective depth (configurable, default 50% of the shallower pool's reserves), the opportunity is dropped and a `liquidity_cap` log line is emitted.
- `loop.ts` is the heart of the bot. Each tick: poll all DEXes for all configured pairs, run the detector, for each opportunity that passes the threshold AND the liquidity cap, build and submit a PTB, log the outcome, and decrement the safety cap. When the cap reaches zero, the process logs and exits.
- Logging events: `startup`, `poll_cycle`, `opportunity_detected`, `below_threshold`, `liquidity_cap`, `ptb_submitted`, `ptb_success`, `ptb_revert`, `ptb_error`, `cap_reached`, `shutdown`. Each is a structured JSON line with a stable shape.
- The loop is sequential (no concurrency in v1) — simpler to reason about, easier to read in logs.

**Test scenarios:**
- Happy path: a single tick where detector returns one opportunity, builder emits a PTB, submit returns success, the cap is decremented by one. Edge case: detector returns an opportunity whose size exceeds the liquidity cap → logged and skipped, cap unchanged. Edge case: cap reaches zero → process exits with `cap_reached` log. Error path: PTB submit returns a typed error → logged as `ptb_error`, cap decremented (per AE5 we count attempts, not just successes — see deferred note).

**Verification:** Manual end-to-end on SUI testnet: `npm run dev` runs the bot, the operator observes structured log output, and the safety cap can be set to a small number (e.g., 1) so a single PTB is submitted in a controlled test.

---

### U6. Test Scaffolding and CI Hookup

**Goal:** Wire the test framework, run all unit tests, and document the manual verification path for live testnet behavior.

**Requirements:** (covers the verification half of U1–U5; no new behavior)

**Dependencies:** U1, U2, U3, U4, U5

**Files:**
- Create: `test/setup.ts` (vitest setup, no globals beyond `describe`/`it`/`expect`)
- Create: `.gitignore` (node_modules, config.json, *.log)
- Modify: `package.json` (add `test`, `typecheck`, `lint` scripts)

**Approach:**
- All unit tests live next to the units they cover (see per-unit test files). They mock the Sui SDK and the RPC layer, so they run offline.
- Live testnet behavior is verified manually per the origin's success criteria — there is no CI hook that touches a real chain.
- A `README.md` is deferred to a follow-up unit; for v1 the example `config.json` and the inline log events are the documentation.

**Test scenarios:**
- Happy path: `npm test` runs all unit tests with no failures. Edge case: a test that requires env vars or a live RPC is gated behind a `LIVE_TESTNET` env var so default `npm test` stays offline.

**Verification:** `npm test` exits 0 in an offline environment.

---

## System-Wide Impact

- **Interaction graph:** the bot has no external HTTP/queue callbacks; the only network surface is the Sui RPC read (poll) and the Sui RPC write (submit). Process termination is the only escape from the loop.
- **Error propagation:** all DEX and chain errors are typed and caught at the loop boundary. The loop logs and continues, never crashes the process on a single failed tick.
- **State lifecycle risks:** the only mutable state across ticks is the `SafetyCap` counter. There is no disk state, no DB, no cache to invalidate. A process restart resets the counter — this is documented in the config example.
- **API surface parity:** none. The bot is a process, not a library.
- **Integration coverage:** the only integration that matters — a real PTB executing on SUI testnet — is verified manually per the origin's success criteria. The unit tests cover all deterministic logic.
- **Unchanged invariants:** none. This is a greenfield project; there is no existing surface to preserve.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Sui TS SDK version drift or breaking changes between research and implementation | Pin a specific SDK version in `package.json`; upgrade explicitly when needed. |
| NAVI flashloan contract on testnet differs from the assumed signature | Implementation-time lookup of current package ID; Suilend documented as fallback (R5). |
| One or more of the three DEXes doesn't have a clean SDK or query path on SUI testnet | The `DexClient` interface bounds the damage; a missing adapter becomes a clearly-scoped follow-up unit. If a DEX is unbuildable, the bot still works against the remaining two, and the operator can disable it in config. |
| Public SUI testnet RPC rate limits polling at 1s × 3 DEXes × 2 pairs | Configurable cadence; if rate-limited, the operator dials up the interval. No bursty behavior in v1. |
| Live testnet behavior cannot be verified in CI | Documented in the origin's success criteria; manual verification is the contract. |
| The "profitable on testnet" success bar is ambitious and may not be hit | Recorded as a stretch criterion in the origin; the bot's value to the operator is the structured log signal of what edges exist, not a guaranteed positive PnL. |
| A misconfigured `privateKey` would expose mainnet funds if reused on testnet | The config loader accepts any keypair; the operator is responsible for using a testnet-only keypair. README guidance deferred; a `config.example.json` comment is the v1 mitigation. |

## Documentation / Operational Notes

- The structured JSON log events are the primary documentation surface for v1. Each event has a stable shape; downstream tooling can parse them.
- A future `README.md` is the natural follow-up once the bot's behavior is known to be stable. It is intentionally not part of v1.
- The operator's operational steps to run the bot:
  1. `npm install`
  2. Copy `config.example.json` to `config.json`, fill in `rpcUrl`, `privateKey`, and adjust `pairs` / `dexes` / `threshold` / `maxSubmissions` / `pollIntervalMs`.
  3. `npm run dev` to start the bot.
  4. Pipe stdout to a file (e.g., `npm run dev | tee bot.log`) for persistence.
  5. `Ctrl+C` to stop; the safety cap also stops the process automatically.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-07-sui-flashloan-arbitrage-bot-requirements.md](../brainstorms/2026-06-07-sui-flashloan-arbitrage-bot-requirements.md)
- **External docs:** Sui TypeScript SDK; Sui PTB / `Transaction` API; NAVI Protocol flashloan; Cetus, Turbos, Aftermath CLMM swap modules.
