---
'@dudousxd/nestjs-agent-core': patch
---

Let an operator approve a parked question set without killing the run.

An elicitation is deliberately persisted as `toolType: 'action'`, `status: 'pending_approval'`, which
is what puts it in the approvals inbox a deployment already has instead of needing one of its own.
The cost of that choice was never paid: pressing **Approve** there sends a `Decision`
(`{ approved: true }`), and `resolveElicitation` read `reply.answers[question.id]` off an object with
no `answers` — a `TypeError`, thrown outside the loop's tool `catch`, so the run recorded as failed.
The signal payload is journaled, so every replay reproduced it. The run was unrecoverable.

`awaitElicitation` had a fallback that translated a `Decision` into a reply, but only when
`hooks.awaitAnswers` was undefined — and both shipped runners always define it, so the fallback was
dead on every production path.

`normalizeElicitationReply` (exported) now reduces a reply **where it is consumed**, on both paths:
a reply with no `answers` becomes `{ answers: {} }` — which takes every question's own pre-picked
default, exactly what "just submit" already means on this surface — and `approved === false` becomes
a skip, which is already this surface's word for declining to answer. `executedByRef` carries through
as `answeredByRef`, so the audit row still names who settled it. A reply that already carries answers
is returned unchanged.

`resolveElicitation` / `settleElicitation` accept `ElicitationReply | Decision`, and
`AgentLoopHooks.awaitAnswers` is declared as returning `HumanReply` — which is what the channel
really carries. It also makes the documented claim ("a host that only implemented `awaitApproval`
still completes an elicitation") true on the shipped runners rather than only on paper.
