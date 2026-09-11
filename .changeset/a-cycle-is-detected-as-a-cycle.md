---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

A delegation cycle is now detected as a cycle, not guessed at from depth.

The loop only ever received a delegation COUNT, so a count was all it could reason about. That
conflates two different faults. A mutual handoff (A→B→A→B…) ran five agent turns before anything
stopped it and then reported `delegation depth limit of 5 reached`, which leaves the reader to work
out whether their chain was looping or merely long — the one question a count cannot answer. And a
legitimate chain of six DISTINCT agents was refused for resembling a cycle it was not.

The chain of agent names costs exactly what the counter cost to thread. `AgentRunInput.delegationPath`
carries it, both runners append their own agent for each child they start, and the loop compares the
delegation target against its own ancestry. A repeat IS the cycle:

    (delegation cycle: alpha → beta → alpha — alpha 2 times on one chain)

`AgentLoopDeps.maxAgentAppearances` / `@Agent({ maxAgentAppearances })` defaults to **1**. It counts
APPEARANCES, so `2` admits exactly one deliberate return to an earlier agent. The depth ceiling stays
as the backstop for a chain that is long without repeating, and is reported only when nothing is
circular.

**Upgrading.** Nothing to configure. A runner that threads no chain — a custom one — reads an empty
ancestry, finds no repeat, and falls back to the depth ceiling exactly as before. Both bundled
runners thread it.

**Behaviour that changes.** A chain that revisits an agent is now cut at the first repeat instead of
at depth 5. If you depended on an agent being delegated to twice on one chain, set
`maxAgentAppearances`. Note this is strictly earlier, not stricter in the end: such a chain was
already being cut, just four agent runs later and under a message that named the wrong reason.

Also: the `Required<AgentOptions>` gate added alongside the depth ceiling caught its own author
forgetting to surface `maxAgentAppearances` on the decorator, within the hour. It only bites under
`typecheck:specs`, which `@dudousxd/nestjs-agent` does not yet run.

**Known limit, unchanged by this.** `@Agent({ handoff })` cannot express A↔B directly, because a
class cannot name a class declared after it. Mutual edges arrive through circular imports between
agent modules, which is the shape this guard is for.
