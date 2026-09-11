---
'@dudousxd/nestjs-agent': minor
---

Dispatching a turn off its pod is now something a deployment says, not something it inherits.

`dispatchedSteps` decides where the turn's model call and its tool executions run: inside the
`agent.run` workflow body, or inside whichever worker serves the `AgentRunSteps.llm`/`.tool` groups.
It defaulted to ON under `durable: true`. It now defaults to OFF, and `dispatchedSteps: true` is the
only way to route those two steps.

**Why it cannot be a default.** The flag relocates the HOST's own code. A `@AiTool` handler stops
running in the turn's workflow body and starts running in a step worker — and the `llm` step re-runs
the host's tool-visibility callbacks there too, to rebuild its tool list. A handler that resolves
anything per invocation from the context its caller was in finds nothing in that worker: a
request-scoped ORM EntityManager, an AsyncLocalStorage tenant, a CLS transaction. Nothing in this
library can tell whether a given host's tools do that, so nothing in this library should be picking
the answer.

The worst case is an `action` tool, because HITL is built on the promise that approving one runs it.
A relocated handler that cannot resolve its context throws, the loop records the call `failed` and
hands the error to the model as a tool result, and the turn completes — so a human's approval is
spent, the action never happens, and the audit row reads like the tool's own bug.

**Upgrading.** A host that named no `dispatchedSteps` gets the in-process path, which is the path
this library has actually been running: the flag was inert until 0.12.0, because
`AgentRunWorkflow`'s `AgentRunSteps` parameter was typed as a union and so had no resolvable
`design:paramtypes` token to inject. Set `dispatchedSteps: true` to route the two long steps, once
the tools this deployment registers establish whatever context they need themselves (`@Step`-style:
MikroORM's `@CreateRequestContext()`, an explicit `fork()`, your own ALS entry) and a cross-process
`TokenStreamSink` is wired.

A run already in flight is unaffected either way: the branch is gated on
`ctx.patched('agent:dispatched-steps')`, so a parked turn finishes on the shape its journal holds.

Behaviour is identical on both paths for a tool that needs nothing from its caller, which is why no
test noticed the flag was inert and none would have noticed it turning on. The durable suite now
asserts the journal a `durable: true` host gets when it says nothing — `llm:0` and
`tool:<callId>`, across a full HITL park-and-approve — so where a host's tools execute is a fact a
test holds rather than a default's side effect.
