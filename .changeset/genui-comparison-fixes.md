---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-testing": patch
---

Fixes ported from the AdonisJS sibling's frontends comparison:

- **Hidden tools no longer run.** A tool whose `describe()` answers `available: false` for the turn (a genui `ui__render` or `ui__show_*` tool that `uiCapabilities` rule out) was left out of the tools offered to the model, but still ran when the model called it anyway. `ToolRegistry.invoke` (and `prepare`) now ask `describe()` again with the call's actor, thread, agent and `uiCapabilities`, and refuse the call as an unknown tool (`ToolNotFoundError`). The other offer filters (allow-list, `isEnabled`, roles, `canUse`) were already checked again on invoke.
- **No 501 from the proposals list where there can be none.** `GET <base>/threads/:id/action-proposals` answered `501` on a store without the proposal capability (one that can only run blocking approvals), and `AgentService.listActionProposals` threw `404` in blocking mode. Both answer an empty list now. `useAgentChat` reads that list by default, so every chat on such a store logged a failed request unless it passed `proposals: false`. Approving or rejecting a proposal still refuses.
- **AG-UI approval interrupt wording.** The `tool_approval` interrupt's `message` is now the tool's `confirmation.title` when the call has one, the same wording the `agora.approval-requested` event carries. Before, it was always `Approve <tool>?`.
- **`FakeModelProvider` tool call ids are unique.** Ids were `call-<turnIndex>-<name>`, so the same tool on the same turn of two threads got the same id; a tool call id is the store's primary key across threads. The first call still gets `call-<turnIndex>-<name>`. A repeat from the same provider instance gets the first free `-2`, `-3`… suffix.
- **A Stop aborts what the run is in.** Under the inline runner, cancelling a run aborts the in-flight model call (`ModelTurnArgs.abortSignal`, which `aiSdkModel` passes to the AI SDK) and hands tools the signal as the new `AiToolCtx.abortSignal`. Before, the model kept streaming to the end of the step. The run still ends `cancelled`, and the step the Stop cut short is not persisted. Custom runners can pass a signal through the new `AgentLoopHooks.abortSignal`. The durable runner is unchanged.
