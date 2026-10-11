---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-testing": minor
---

Personal agents (for Personal Agent Protocol "Poppy", experimental):

- `personalAgentGate(policy)`: a caller carrying the `personal_agent` role reaches only tools that declare `personal_agent` or a `scope:<id>` role, and runs only the scopes its user granted; `RolesPolicy.canOffer` lets it be offered a tool it cannot run yet, so the refused call becomes a permission request. `AgentModule` always wraps its roles policy in it (a no-op for every other actor). `personalAgentScopes` resolves no memory or skill scope for a personal agent; `missingScopes`, `scopeRole`, `PERSONAL_AGENT_ROLE`.
- `remember` is offered only to an actor with a memory scope, and `skill` only with a non-empty catalog (a dispatched llm step is told through the envelope's `builtins`).
- `ToolSpec.approvalTtlMs`: an action's card lives as long as what it carries (a sign-in link), over the approval policy's `ttlMs`. `ToolConfirmation.link`: a card whose action is opening a link.
- The pending-proposal receipt carries `note` (`PENDING_ACTION_PROPOSAL_NOTE`), so the model says the action awaits confirmation instead of claiming it was done.
- `ActionProposalWorker` `onAdmitted` / `ActionProposalWorkerService.onAdmitted` and `actionProposalWorker.onAdmitted`: once a settled proposal's outcome is written to its thread — the moment to continue the conversation.
- Poppy store SPIs (`PoppyStore`, `PoppyConnectionStore`, in-memory stores) and the tokens `AGENT_POPPY_STORE`, `AGENT_POPPY_CONNECTION_STORE`, `AGENT_CHANNEL_FOLLOWER`.
- `closeEmptyRoles` keeps a policy's default roles through `personalAgentGate`.
- The loop announces the tool calls a provider did not stream (`announcedToolCalls`, on the inline and the dispatched llm step), so a call's outcome is always attributable to its tool.
- A personal agent's independent proposal records the roles it was proposed under (`ActionProposalExecutionContext.personalAgentRoles`); the worker runs it under those, never as the whole account `backgroundActorResolver` answers.
- Delegation edges take `roles` / `ability` (`delegatesTo: [{ agent, roles }]`, `@Agent({ handoff: [{ agent, roles }] })`), carried onto the synthesized delegate tool.
- The Poppy global-slot contracts (`PoppyAuthenticate`, `PoppyPrincipal`, `POPPY_AUTHENTICATE_SLOT`, `POPPY_ISSUER_SLOT`, `POPPY_ENDPOINTS_SLOT`, `globalPoppyAuthenticate`, `announcePoppyEndpoints`, …) live in core, shared by the Poppy package and the MCP server.
