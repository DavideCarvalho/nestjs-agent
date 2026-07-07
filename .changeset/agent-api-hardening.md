---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
---

Harden and simplify the module surface.

- **Structured stream failures.** A failed run (e.g. quota exceeded) now terminates the token stream with a typed error instead of leaking `[error] …` as assistant text: `SinkWriter.fail()` + `AgentStreamError` (core), an `event: error` SSE frame (backend), and a parsed `type: 'error'` chunk plus `AgentHttpError` carrying `.status` (react). Adds `run.failed` and now actually emits `quota.exceeded` on the diagnostics channel.
- **`forRootAsync` honours `durable`.** It previously hardcoded the inline runner, silently ignoring a factory's `durable: true`. `AgentModuleAsyncOptions` gains a `durable` field.
- **`actorResolver` is now required** (a compile-time obligation) rather than an optional with a throw-on-call placeholder. The `UnconfiguredActorResolver` export is removed — supply an `ActorResolver` (or the opt-in `HeaderActorResolver`).
- **Ledger-backed quota.** New `LedgerQuotaStore` and `forRoot({ quotaLimitTokens })` enforce a daily budget straight off the persisted usage ledger — a production `QuotaStore` that needs no extra shared state across replicas. (The SPI comment referencing a `transport-redis` package that never shipped is gone.)
- **`defaultRoles` is applied once**, by the `RolesPolicy`. Discovery no longer bakes it into every tool spec, which had leaked the module default into custom policies.
- **`delegatesTo` is validated at boot.** A dangling target now fails startup instead of synthesizing a delegate to an unrestricted phantom agent (a privilege-escalation footgun). Agent→agent delegation is also capped at `MAX_DELEGATION_DEPTH`.
- **`useAgentChat` resume simplified.** The three overlapping props (`threadId` + `hasActiveStream` + `activeStreamId`) collapse to a single `resumeRunId`.
- Tool calls now record `executionMs` and their `tool-call` diagnostics carry `durationMs`; the never-read `AgentRunInput.isRegenerate` field is removed.
