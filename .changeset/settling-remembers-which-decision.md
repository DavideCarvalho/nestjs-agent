---
'@dudousxd/nestjs-agent-react': minor
---

**A parked call now reports WHICH decision is in flight, not merely that one is.**

`TranscriptSettleState` is per action — `approve` and `reject` each carry their own
`isSubmitting`, as do `answer` and `skip` — so a consumer reasonably reads one as "this decision is
being sent". They were always equal: `useChatTranscript` tracked settling in a `Set` of
`toolCallId`, which knows that *a* decision is on its way and discards which, and `buildToolCall`
copied that one boolean into both. A surface reading `approve.isSubmitting` therefore said
"Working…" on Allow while the run was carrying out a refusal.

The set is now a `Map<toolCallId, SettleAction>`, and each `isSubmitting` is derived from it. The
information was always there — `approve` calls `settle(id, () => onApprove(id))` — it was just not
kept.

**Breaking for anyone calling `buildTranscriptBlocks` directly.** `ElicitationBlockOptions` and
`ApprovalBlockOptions` replace `isSubmitting: (toolCallId) => boolean` with
`submitting: (toolCallId) => SettleAction | null`. `useChatTranscript` supplies it; hosts that pass
their own options need the one-line change. The new `SettleAction` type is exported.

`available` is untouched and still means "this decision can be made at all", not "nothing is in
flight". Holding both affordances while one is going is the renderer's call, and the two
`isSubmitting` flags are what let it do that while reporting progress on only the pressed one —
`registry`'s `ChatToolGroup` shows the shape.
