---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Let a tool say whether it exists here, and who may use it

Two optional methods on `ToolHandler`, both evaluated per turn and both with DI available:

- `isEnabled()` — is this capability part of this deployment? The feature-flag seam.
- `canUse(actor)` — may THIS actor use it? The per-user seam, on the tool rather than in one
  app-wide policy.

Neither existed before. `roles`/`ability` are checked by a single `RolesPolicy` shared by every
tool, and an agent's `tools` allow-list is fixed when the agent is declared — so "turn this tool
off in staging" or "only accounts on the paid plan get it" had nowhere to live but conditionally
registering the provider, which happens while `@Module` metadata is built, in most apps before
configuration is even loaded.

Both gates run when the turn's tool list is built, so a tool that fails either is never shown to
the model, and again on invoke, which is what stops a HITL action approved before a flag moved from
executing after it. Order is `isEnabled` → `RolesPolicy` → `canUse` → the agent's allow-list; every
layer only removes tools, so none of them can widen what a turn reaches.

Also `@AiTool({ enabled })` for availability that needs no injected service — a boolean, or a
predicate re-read every turn — and a new `ToolDisabledError`, kept distinct from
`ToolForbiddenError` (wrong actor) and `ToolNotFoundError` (no such tool) so a log says which of
the three to go fix.

Purely additive: a tool that declares none of this behaves exactly as before.
