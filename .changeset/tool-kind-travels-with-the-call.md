---
'@dudousxd/nestjs-agent-core': patch
'@dudousxd/nestjs-agent': patch
---

A tool call's kind travels with the call, so the approval gate does not depend on which process replays the turn

`claimToolCall` settles a call's kind inside `persist:toolcall` and journals it from there, which makes every replay agree. It does not make the first writer right: a dispatched turn resumes on whichever instance consumes the model step's result, and settling an approval resumes it on whichever instance took the decision — neither is chosen by role. An instance that registers no tool classes (it serves HTTP and replays run bodies) read `undefined` from its own registry, journaled `read` for an action tool, and auto-executed it. The executor's own guard then refused the dispatch, so the call surfaced as a failure rather than an unapproved side effect — but the approval card never appeared, intermittently, depending on which instance won the race.

The kind is now stamped where the tool was OFFERED: inside the llm checkpoint, by the process that built the definition list the model chose from. A call can only exist because some process offered that tool, so that process is the one that certainly knows it. It rides the step result into the journal from there, and `claimToolCall` writes that value rather than asking its own registry.

- `stampToolKinds(result, deps)` is exported from core for the dispatched `AgentRunSteps.llm` handler, on the same footing as `withAskTool`/`withSkillTool`/`withMemoryTool` — a step handler has to reach the same answer the loop would.
- The inline branch stamps inside `llm:<i>`, so the kinds are journaled rather than re-derived on replay.
- A call that arrives unstamped still falls back to the local registry, so a journal written before kinds travelled replays unchanged.

No checkpoint name, position or count changes.
