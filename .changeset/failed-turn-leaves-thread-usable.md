---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-ai-sdk': patch
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-react': minor
---

A turn that dies mid-step no longer takes its thread with it.

A turn writes its tool results onto the assistant message once the step's last tool has settled. A
run that died before that — refused a checkpoint position, failed while settling a tool — left an
assistant message asking for tools and answered by nothing, and (on a replay refusal) a run row
still `running` and a thread still pointed at the run. The next message on the same thread was then
sent to the provider with a tool call and no result after it, and failed with the AI SDK's "No
output generated. Check the stream for errors." — every time, for the rest of the conversation.

- **History is settled before it is sent.** Reading the thread for a turn now answers every tool
  call its message holds no result for: with what the call's own row says where the store can read
  it (`AgentStore.toolCallOutcomes`, optional, implemented by the in-memory, Drizzle and MikroORM
  stores) — a tool that DID run hands the model its real output, so it is not run a second time —
  and otherwise with a result saying the call was never completed. Done inside `load:thread`, so it
  takes no checkpoint position and a replay composes the same prompt. `settleDanglingToolCalls` /
  `danglingToolCallIds` are exported from core.
- **A run that ends without settling leaves nothing waiting on it.** A failing run settles the calls
  it had put to a person as `failed` (`AgentStore.failUnsettledToolCalls`, optional, same three
  stores). A run refused a checkpoint position — which cannot write a checkpoint — settles its row,
  its calls and its thread straight to the store (`settleDeadRun`); before, it did none of the
  three. A send that finds its thread held by a run that is gone settles that run's calls too.
- **A decision for a run that is over is refused**, not swallowed: `approve` / `reject` / `answer` /
  `skip` throw `RunNotActiveException` (`409 { code: 'run_not_active' }`) instead of signalling a
  run that will never read it — the card no longer says "approved" for something that will not run.
- **The error frame is written for the person reading the chat.** It carries a stable `code`
  (`run_failed`, plus the new `replay_diverged` and `model_no_output`) and, in production,
  `RUN_FAILED_MESSAGE` instead of the error's own text; the error is logged with its run id and
  stays on the run row. Outside production the raw message still rides the frame;
  `exposeStreamErrorDetails(true | false)` decides it outright. Messages the library words itself
  (`quota_exceeded`, `output_rejected`, `structured_output_invalid`) are unchanged. A client that
  matched on the raw text of a `run_failed` message in production must switch to the `code`.
- **`aiSdkModel` throws the provider's own error** when the stream carries one, instead of letting
  it surface as "No output generated".
- **React (headless).** `chat.runError` is the failed run's `{ code, message, runId? }` until the
  next attempt starts, and the transport takes `onRunError`; `isRunNotActiveError(error)` recognises
  the 409 on a decision, and the transcript model carries it as `call.errorCode` /
  `elicitation.errorCode` next to `error`. `AGENT_RUN_ERROR_CODES` lists the codes. Nothing is rendered: the app words
  each code itself.
- **A tool is handed an idempotency key.** `ctx.idempotencyKey` is `<runId>:<toolCallId>` — the same
  for every execution of one call — and `ctx.toolCallId` names the call. A worker that dies between
  a tool's side effect and the checkpoint that records it re-runs the tool on recovery; passing the
  key on to whatever the tool writes to is what makes the second attempt land on the first.
