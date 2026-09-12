---
'@dudousxd/nestjs-agent': major
---

**Breaking.** `dispatchedSteps` is gone from `AgentModuleOptions` and
`AgentModuleAsyncOptions`. A turn's model call and each of its tool executions are dispatched steps
(`AgentRunSteps.llm` / `AgentRunSteps.tool`), always. `AGENT_DISPATCHED_STEPS` is no longer exported
from `@dudousxd/nestjs-agent/durable`.

**Why there is no option.** `@dudousxd/nestjs-durable` deliberately has one step primitive:
`ctx.step` is "always dispatched, always engine-scheduled", and `ctx.localStep` is the named escape
hatch for work that must run in the workflow body. In that ecosystem dispatch is not a
configuration; it is what a step IS. `dispatchedSteps` reintroduced exactly the placement choice
durable removed, and the objection to dispatching — that it relocates the host's `@AiTool` handlers
into a worker where a request-scoped dependency does not exist — is not special to the agent. It is
the ordinary condition of every `@Step` handler, and hosts already pay it.

**Why the field is deleted rather than deprecated.** Removing it makes a deployment that sets it
fail to COMPILE, which is louder and earlier than a boot warning, and cannot be scrolled past.

**Upgrading.** Delete the option. Then, because this is the release where it stops being a no-op,
work through what dispatch actually asks of your code:

- **Every `@AiTool` handler that reaches infrastructure needs its own execution context** —
  `@CreateRequestContext()` or `@EnsureRequestContext()` under MikroORM, an explicit `fork()`, your
  own AsyncLocalStorage entry — exactly as every `@Step` handler in this ecosystem already does. The
  `llm` step re-runs your tool-visibility callbacks in that worker too.
- **The failure mode if you skip it** is not a crash you will notice. Under NestJS + MikroORM with
  `allowGlobalContext: false`, the handler throws in the worker, the loop records the tool call
  `failed`, the error is handed to the model as a tool result, and the turn completes normally. On an
  `action` tool that means a human's HITL approval has been **spent** on a tool that never ran, and
  the audit row reads like the tool's own bug.
- **Confirm the routed groups are served.** `AgentRunSteps.llm`/`.tool` are registered by
  `AgentDurableModule` under every surface except `'http'`; a fleet whose only agent pods are
  `surface: 'http'` has nothing to dispatch to.
- **Wire a cross-process `TokenStreamSink`** (e.g. the `/sink-redis` subpath) on more than one pod.
  The boot warning for the default in-process sink now fires on `durable: true` itself, from
  `DurableAgentRunner`, since the turn already leaves the pod that took the request.

**The history matters here, because it is what makes this surprising.** The flag defaulted ON and was
*inert* for twelve minor releases — `AgentRunWorkflow` took it as an `@Optional()` parameter typed
`AgentRunSteps | undefined`, a union, so `design:paramtypes` carried `Object`, Nest had no token to
resolve, and `undefined` was injected. Every turn ran in-process whatever the flag said. 0.12.0 made
it live; 0.13.0 then made it default OFF and required a deployment to state `dispatchedSteps: true`.
So for a host coming from `≤0.11.x`, **this is the first version in which their tool handlers
actually move off the pod.** The parameter is not coming back in any form: the workflow routes by the
`@Step`-stamped name off `AgentRunSteps.prototype` and needs no instance, which is also what lets an
`'http'` pod that provides no `AgentRunSteps` write the same checkpoint names an engine pod does.

**A run already in flight is unaffected.** Which names a turn writes — the routed groups or the
in-process `llm:<i>`/`tool:<callId>` — is answered by `ctx.patched('agent:dispatched-steps')`, from
the run's own journal and nothing process-local: a fresh run records the marker and dispatches, and a
run whose position already holds a real step rewinds (spending no position) and finishes on the names
its history holds. The marker therefore cannot be retired while any run journaled by an earlier
release can still resume.

**Also in this release:** `DurableAgentRunner.cancel` now releases the thread's active stream itself,
reading the thread id off the run's own recorded input. It used to be left to the workflow body, on
the reasoning that only the body knows which thread was streaming — but a cancelled turn is usually
suspended (parked on a human, or on one of the dispatched steps a turn now spends most of its life
in), and a suspended body never reaches its own catch: the runtime settles the run from outside it.
Left alone, the thread reported a live stream for a run that had stopped, for ever.
