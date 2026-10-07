---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": patch
---

AG-UI:
- The `agora.ui` event now carries `fallbackText` and `componentVersions`, so a client without a renderer for the component can still show something.
- `agora.approval-requested` now carries the proposal `target` and its `confirmation`. An interrupt left open for a proposal says `agora.target`, and its id names the proposal and its thread.
- Resuming a proposal interrupt now decides it through the proposal service, the same path as `POST .../action-proposals/:id/approve|reject`. A caller who may not decide it gets that service's `403`/`404`. Before, the resume tried to signal the finished run and got `409`.
- `AgentService.decideActionProposal` is the new entry point the resume uses.

**Breaking:** the AG-UI custom event for a proposal decided without a model run is renamed from `aviary.action-proposal-decision` to `agora.action-proposal-decision` (`AG_UI_CUSTOM.actionProposalDecision`), to match every other custom event. The old name is not kept.
