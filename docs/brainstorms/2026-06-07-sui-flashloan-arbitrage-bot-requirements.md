---
date: 2026-06-07
topic: sui-flashloan-arbitrage-bot
---

# SUI Flashloan Arbitrage Bot

## Summary

A TypeScript cross-DEX flashloan arbitrage bot on SUI testnet, auto-executing, that polls three SUI CLMMs for price spreads on a small pair list and submits a single PTB per detected edge above a fee-aware threshold. v1 is testnet-only, runs locally as a single Node.js process, and is sized to teach the operator the end-to-end SUI arb stack without spending their $10 gas budget.

## Problem Frame

SUI is a newer Move-based chain where retail MEV accessibility is still in an early window: less professional searcher density than Ethereum mainnet, but also less liquidity and less documentation. For someone with a small gas budget and no prior MEV experience, the question is whether the on-ramp to SUI arbitrage is real, or whether the realistic answer is "wait for liquidity and infrastructure to mature." A v1 bot is the truth-telling instrument here: it surfaces what edges actually exist for a small-budget, polling-cadence operator, distinct from what a professional searcher with co-located infrastructure could capture.

## Actors

- A1. **Operator (you)** — runs the bot process locally on a personal machine; starts, stops, and inspects logs. Sets the threshold parameters and pair list at startup.
- A2. **Bot** — autonomous TypeScript process that polls SUI DEX pool state, evaluates spreads, and submits PTBs. No human in the loop during normal operation.
- A3. **SUI CLMM DEXes (Cetus, Turbos, Aftermath)** — external systems that expose pool state and accept swap calls in PTBs. The bot reads from and writes to these.
- A4. **SUI flashloan provider (NAVI, with Suilend as fallback)** — external system that lends capital within a single PTB on the condition of repayment in the same PTB.

## Key Flows

- F1. **Detect-and-execute loop**
  - **Trigger:** Bot process started by operator.
  - **Actors:** A2 (bot), A3 (DEXes), A4 (flashloan provider)
  - **Steps:**
    1. Bot reads current mid-price for each configured pair from each of the three DEXes via public RPC.
    2. Bot computes the maximum cross-DEX spread for each pair, accounting for trade size and expected slippage from pool depth.
    3. If the net spread (gross spread minus estimated gas + flashloan fee + slippage safety margin) exceeds the configured minimum edge threshold, the bot constructs a PTB: borrow from flashloan provider → swap on cheaper DEX → swap on more expensive DEX → repay flashloan.
    4. Bot submits the PTB and records the outcome (success with estimated PnL, revert with reason, or submission error).
    5. After execution, or after a non-action interval, the bot returns to step 1 on the configured cadence.
  - **Outcome:** Loop continues indefinitely until the operator stops it or the per-run safety cap is reached; logs accumulate a complete record of every detection, attempt, and result.
  - **Covered by:** R1, R2, R3, R4, R5

- F2. **Insufficient liquidity handling**
  - **Trigger:** A spread is detected but the projected optimal swap size would exceed effective liquidity in at least one of the two target pools.
  - **Actors:** A2 (bot)
  - **Steps:**
    1. Bot detects that the optimal swap size for the spread is larger than the shallower pool's effective liquidity.
    2. Bot logs a "liquidity cap" record naming the limiting pool and skips the opportunity (in v1, no automatic down-sizing).
  - **Outcome:** No PTB is submitted that would revert due to insufficient liquidity; the opportunity is logged so the operator can see what the bot *would have done*.
  - **Covered by:** R6

- F3. **Operator visibility**
  - **Trigger:** Operator inspects logs after the bot has been running.
  - **Actors:** A1 (operator)
  - **Steps:**
    1. Operator reads log output to see: how many times each pair was checked, how many spreads were detected, how many PTBs were submitted, the success rate, and total estimated PnL.
    2. Operator can drill into per-attempt detail: which DEXes were involved, the spread at submission, gas used, and revert reason if any.
  - **Outcome:** Operator can answer: "is this bot doing what I think it is, and are there any real edges here?"
  - **Covered by:** R7

## Requirements

**Detection**
- R1. The bot polls at least three SUI CLMM DEXes — Cetus, Turbos, and Aftermath — for the configured pair list, on a configurable cadence no faster than 1 second per pair.
- R2. For each poll cycle and each configured pair, the bot computes the cross-DEX spread that would result from executing an arb trade, accounting for estimated slippage derived from pool depth.

**Threshold and execution**
- R3. The bot executes a PTB only when the net spread (gross spread minus estimated gas cost, flashloan fee, and a slippage safety margin) exceeds a configured minimum edge threshold.
- R4. Each executed PTB follows the pattern: borrow from the flashloan provider → swap on the cheaper DEX → swap on the more expensive DEX → repay the flashloan — all within a single PTB so the operation is atomic.
- R5. The bot uses NAVI as the default flashloan provider; Suilend is acceptable if NAVI's PTB integration proves problematic during implementation.

**Safety and observability**
- R6. The bot must not submit a PTB whose swap size would exceed the available liquidity of either target pool. Such opportunities are logged and skipped.
- R7. The bot logs every detection (pair, DEXes involved, raw spread), every submission attempt (the constructed PTB shape, gas budget, threshold at time of decision), and every outcome (success with estimated PnL, revert with reason, or submission error).
- R8. The bot enforces a configurable per-run maximum on PTB submissions (count or total estimated gas) so a misbehaving run cannot exhaust the operator's gas budget before the operator notices.

**Pair scope**
- R9. v1 monitors SUI/USDC and DEEP/USDC. Adding additional pairs is a configuration change, not a code change.

## Acceptance Examples

- AE1. **Covers R1, R2.** Given the bot is running and SUI/USDC is configured, when a poll cycle completes, then the bot has read fresh mid-prices from all three DEXes and computed a slippage-adjusted spread.
- AE2. **Covers R3.** Given the computed net spread is below the configured threshold, when the poll cycle completes, then no PTB is submitted and a "below threshold" log line is emitted.
- AE3. **Covers R4.** Given a net spread above the threshold and sufficient liquidity, when the bot executes, then the submitted PTB contains exactly the operations: borrow, swap A, swap B, repay, in that order, within a single transaction.
- AE4. **Covers R6.** Given a detected spread whose optimal trade size exceeds the shallower pool's effective liquidity, when the poll cycle completes, then no PTB is submitted and a "liquidity cap" log line is emitted naming the limiting pool.
- AE5. **Covers R8.** Given the configured maximum submission count has been reached, when the next eligible spread is detected, then the bot does not submit, emits a "max submissions reached, exiting" log line, and terminates the process.

## Success Criteria

- The operator can run the bot on testnet with a single command and observe log output that explains what the bot is doing at every step (detection, decision, submission, outcome).
- The bot successfully submits at least one PTB on testnet that does not revert, *or* the operator can identify from the logs exactly why no PTB has been submitted (still polling, no edges detected, all edges below threshold, or insufficient liquidity).
- After a sustained testnet run, the operator can answer the question "is there a real edge here for a small-budget polling operator?" based on observed detection rates and execution outcomes, not based on intuition.
- A downstream planning agent can pick up this doc and produce a concrete implementation plan without needing to invent product behavior, pair selection rationale, or success interpretation.

## Scope Boundaries

- Multi-strategy support (triangular arbitrage, liquidations) — out of scope for v1. Liquidations are a natural v2 candidate that escapes the cross-DEX latency race.
- MEV-aware execution (mempool scanning, validator-level capture, private order flow) — out of scope; the bot submits via public RPC.
- CEX-DEX arbitrage — out of scope; the v1 stack is on-chain only.
- Production hardening (high availability, persistence, alerting, monitoring dashboard, multi-account capital management) — out of scope for v1; v1 is a single-process research tool.
- Mainnet deployment — out of scope for v1. v1 is testnet-only by design; mainnet probing is a v2 decision gated on v1's behavior.
- Historical backtesting of past spreads — out of scope for v1. The bot runs in real time only.
- Auto-tuning of the threshold parameter — out of scope for v1. The threshold is a startup-time configuration.

## Key Decisions

- **TypeScript via Sui TS SDK over Rust, Python, or Move-only.** The TypeScript SDK has the best documentation and example coverage on SUI; the polling cadence is well within TypeScript's latency envelope for this use case. The trade is lost execution speed on mainnet later, but v1 is testnet-only and learning-optimized.
- **Polling over event-stream subscription for v1.** Streaming detection would be faster but adds subscription reconnect logic, race conditions, and debugging surface that don't help a beginner learn the fundamentals. Polling makes the latency constraint a *visible* one you can choose to optimize later.
- **Testnet-first.** Testnet gas is free, so the operator can run the bot for an extended period without spending the $10 budget. The trade is testnet liquidity is thin and often synthetic, so the "profitable on testnet" success bar is a stretch, not a guarantee.
- **Threshold-based execution, not "execute every detected spread."** Without a threshold, the bot would submit PTBs whose expected PnL is negative after fees and gas, producing real losses on mainnet later. The threshold is a guardrail that earns its place even when the testnet gas cost is near zero.
- **NAVI as default flashloan provider, with Suilend as fallback.** NAVI's flashloan flow integrates cleanly with PTB composition; Suilend is a documented alternative if implementation surfaces a problem.

## Dependencies / Assumptions

- **The SUI TypeScript SDK provides first-class support for PTB construction** that can atomically compose a flashloan borrow, two swaps, and a flashloan repay. *Unverified against the SDK at this stage; planner should confirm.*
- **NAVI exposes a flashloan function callable within a PTB** on SUI testnet. *Unverified against current NAVI contracts at this stage; planner should confirm contract addresses and function signatures.*
- **Cetus, Turbos, and Aftermath all expose their pool state via public SUI RPC** in a form that can be polled on a 1-second cadence without rate limits. *Unverified; planner should confirm rate limits and consider subscription alternatives if needed.*
- **The operator can run a long-lived Node.js process on their local machine.** The bot is not designed for short-lived or serverless execution; a laptop that sleeps will pause the bot.
- **Testnet pricing is informative enough** to teach the operator the structure of SUI arbitrage, even if profitable edges are rare.

## Outstanding Questions

### Resolve Before Planning

- None. The remaining open decisions (e.g., polling cadence default, threshold default, exact log format, configuration file shape) are operational tuning that planning can default with rationale.

### Deferred to Planning

- **[Technical]** Confirm Sui TypeScript SDK PTB composition API and the exact sequence of calls for `borrow → swap → swap → repay` in a single transaction.
- **[Technical]** Confirm NAVI flashloan function signature, fee structure, and contract package ID on SUI testnet.
- **[Technical]** Confirm Cetus, Turbos, and Aftermath public RPC endpoints, pool-state query shape, and rate limits.
- **[Needs research]** Identify a sensible default minimum-edge threshold for the testnet case. Testnet gas is effectively free, but the threshold still anchors operator intuition for v2 mainnet probing.
