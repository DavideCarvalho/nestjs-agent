---
'@dudousxd/nestjs-agent-react': minor
---

Render the question the agent asked — and settle it — from the client.

Elicitation shipped complete on the server and completely absent from the client. The transport's
event switch had no `elicitation` case, so the frame fell through `default: break` and the question
set was dropped in silence; `AgentClient` had no `answer`/`skip`, so every consumer hand-rolled the
fetch; and there was no inline surface, so the only place a form could go was a side panel beside
whatever conversation happened to be on screen.

**The orphan settlement.** Worse than a missing form: an authored intake asks BEFORE the turn's first
model call, so its later `tool-output` was the first the client ever heard of that tool call. The AI
SDK settles a tool part by looking it up by call id and throws `UIMessageStreamError` when there is
none — which drops the whole streamed message, with no console error. The answer was in the store and
nothing rendered. The transport now opens the part when the `elicitation` frame arrives, carrying the
request as the call's `input` under the name the row is persisted with (`ask`), so a live turn and a
reloaded thread produce the identical part. A call the stream already announced — the model's own
`ask` — is left exactly as it was, so a consumer's `onToolCall` never fires twice for one call.

**`AgentClient.answerToolCall({ toolCallId, answers? })` and `skipToolCall({ toolCallId })**, matching
`approveToolCall`/`rejectToolCall` in shape and in raising `AgentHttpError` for the status. Omitting
`answers` submits nothing and lets every question take the default it was shown with. `useAgentChat`
exposes them as `answer`/`skip` beside `approve`/`reject`.

**The transcript model** gains an `elicitation` block: the preamble, the questions numbered against
`questionCount`, each option with its `hotkey`, `isDefault` and `isSelected`, a `selected` list, an
`isPristine` flag, and `answer`/`skip` as state machines with `available`, `isSubmitting` and a
surfaced `error`. Only the questions the user actually TOUCHED are submitted, so the questions they
left alone still persist as `defaulted` rather than as choices they made. A settled set keeps
rendering — read-only, showing what was chosen — through the same markup. Lifting is opt-in on
`onAnswer`, exactly as `sources: true` is: without somewhere to send an answer, a question set is
still a tool card. Detection is structural, never by tool name, because an intake and an `ask` are
persisted under whatever name their row holds.

**A tools block now also carries `calls`** — the same parts, each with `isAwaitingApproval` and its
own `approve`/`reject` machines, wired through `onApprove`/`onReject`. An `action` tool's input lands
and its output never follows on its own, so a parked-looking card IS the pending approval; a question
set parks the same way and is excluded, because approving one settles nothing.

**Registry:** a new `ChatElicitation` renders the form INLINE in the turn that asked it — letter
hotkeys per option, pre-checked defaults, "Question N of M", Confirm on submit and Skip, light and
dark, keyboard operable. `ChatToolCard` grew an approve/reject row and reports "Needs approval"
instead of "Running", and `ChatToolGroup`/`ChatMessage`/`ChatTranscriptView`/`AgentChat` gained a
`renderToolPart` escape hatch that hands the host the whole call, decision state and all — so HITL is
finally renderable through `AgentChat` as shipped. `ChatToolGroup` now takes the `tools` block itself
rather than its `parts`, matching every other component in the block.
