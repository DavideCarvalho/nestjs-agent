---
'@dudousxd/nestjs-agent-codegen': minor
'@dudousxd/nestjs-agent': patch
---

Every package's specs are typechecked now, and two published signatures were wrong.

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
