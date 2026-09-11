---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

The delegation nesting ceiling belongs to the host.

`MAX_DELEGATION_DEPTH = 5` was a constant nobody could change, sitting next to a `maxSteps` that
has always been `deps.maxSteps ?? 8`. It is now `AgentLoopDeps.maxDelegationDepth`, surfaced as
`@Agent({ maxDelegationDepth })` and defaulting to the same 5. The refusal message reports the
ceiling that actually applied rather than the default.

**What this is not.** It does not cap FAN-OUT — how many agents a turn delegates to has always been
the model's decision, one tool call per target agent, and nothing in the library limits it. What the
ceiling bounds is a chain the model cannot see: in a `delegatesTo` cycle (A→B→A) every agent is
making one reasonable call, and the recursion is a property of the wiring, not of any decision. That
is why it stays a guard and not a removable knob — but why the number should be yours.

Also gated: `@Agent` options are copied into the registered `AgentDefinition` by one hand-written
spread per field, so an option added to the decorator and forgotten there was accepted and discarded
with nothing to fail. A new spec builds an agent from a fixture typed `Required<AgentOptions>` and
asserts all thirteen reach the definition — it stops compiling when an option is added, which is
earlier than any assertion could catch it.
