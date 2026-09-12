# @dudousxd/nestjs-agent-codegen

## 0.5.0

### Minor Changes

- [#114](https://github.com/DavideCarvalho/nestjs-agent/pull/114) [`a7b848a`](https://github.com/DavideCarvalho/nestjs-agent/commit/a7b848a53e696f03ab0b8539260f7b51b019ff3b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Six JSON routes the library serves were missing from the generated client, so every host using
  codegen had no typed way to call them: `GET /agent/skills`, `GET /agent/memories`, `DELETE
/agent/memories/:id`, `POST /agent/tool-call/answer`, `POST /agent/tool-call/skip` and `GET
/agent/attachments`. Their siblings were all there, which is what made the gap invisible — a
  frontend reaching for `api.agent.skills.list()` found nothing and had no reason to suspect the
  endpoint existed.

  The list is hand-written against controllers this package deliberately does not import, so it can
  only drift. `covers-every-json-route.spec.ts` now reads those controllers off disk and fails when a
  route is in neither the injected list nor an explicit not-modelled list. Three routes are on that
  list, each for a reason codegen cannot express: the two SSE chat endpoints, and the multipart
  `POST /agent/attachments`.

## 0.4.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Every package's specs are typechecked now, and two published signatures were wrong.

  `typecheck` compiles each package's sources with `*.spec.ts` excluded; `typecheck:specs` compiles
  them with the specs included. Ten of the seventeen packages had no `typecheck:specs` at all, so
  their specs had never been typechecked — 372 errors were waiting in them, and behind those errors
  sat fakes that did not implement what they claimed and calls that named options and parameters
  nothing accepts.

  Two of the findings are in shipped code, not in the tests:

  - `nestjsAgentCodegen()` declared its return as the bare `CodegenExtension`, whose `transformRoutes`
    is optional, takes an `ExtensionContext`, and may return a promise or nothing. The extension
    always defines it, runs synchronously and reads no context, so every caller holding the result had
    to widen or cast to use it. It returns the new `AgentCodegenExtension` instead, which says so.
  - `LedgerQuotaStore.bump()` declared no parameters. It is a deliberate no-op — the ledger already
    holds the turn's tokens — but `QuotaStore.bump` takes `(actorRef, day, tokens)`, and a shorter
    function is assignable to a longer one, so the arity mismatch only showed up for a caller holding
    the concrete class. It now declares the parameters it ignores.

  Worth naming among the spec-side findings, because each is a check that was not happening:

  - Nine durable/runner module setups omitted `AgentModuleOptions.actorResolver`, which is required
    precisely so that no deployment can forget it.
  - Two `waitForRun` calls asked for `until: 'suspended'`, which is not one of the two states that
    option has. The engine treats anything but `'terminal'` as `'settled'`, so they were already
    waiting for what they meant.
  - The `@Agent` fixture typed `Required<AgentOptions>` — there to stop compiling when an option is
    added and forgotten — carried an `intake` that was not an `AgentIntake`, so the one field it was
    guarding was never guarded.
  - Two agent-loop fakes were built by spreading a class instance, which copies no prototype method;
    neither was the `AgentStore` its annotation claimed.
  - The React `fetch` fakes returned `Response`-shaped object literals behind `as unknown as typeof
fetch`, so neither the fakes nor the recorded call tuples were checked against `fetch` at all.

  `packages/core` is the case that needed a decision rather than a fix: its specs use
  `@dudousxd/nestjs-agent-testing`, which depends on core, so declaring it would close a
  core → testing → core cycle in `build`. Its spec project resolves both packages to their TypeScript
  sources instead — exactly what Vitest's own alias already does — so the typechecker sees what the
  tests execute and no package graph edge is added.

## 0.3.1

### Patch Changes

- ad8e446: Behavior-preserving simplification pass across the governance surfaces.

  - **core**: extract the shared, pure governance aggregation helpers
    (`estimateCost`, `bucketByModel`, `bucketByActor`, `bucketByThread`,
    `bucketUsageTrend`, `dayBoundsUtc`) so the cost formula, bucketing, and
    day-bounds math live in one place.
  - **store-mikro-orm / store-drizzle / testing**: the three
    `AgentGovernanceQueries` adapters now only fetch their DB-specific rows,
    map them to the shared `GovernanceUsageInput` shape, and call the core
    helpers — deleting the duplicated cost/bucket/day-bounds code.
  - **codegen**: fix the `USAGE`/`StoredMessage` wire contracts that had
    drifted from core's real types, and inject the four missing controller
    routes (agents catalog, thread rename/promote/truncate-from-message).
  - **telescope**: collapse the eight governance data providers into a single
    `governanceStatProvider(name, fetch, format)` factory.
