---
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-dashboard': minor
---

Live-testing fixes from the first dispatched-steps consumer:

- **CRITICAL — durable turns on the BullMQ thin worker no longer corrupt their history.** The
  workflow's control-flow classification used `instanceof WorkflowSuspended`, but the thin worker's
  suspends throw `@dudousxd/durable-worker`'s `Suspend` — a different class — so every dispatched
  llm step's suspend was misclassified as a real failure: the failure path ran DURING the suspend,
  emitted extra checkpoints, and the resumed replay died with NondeterminismError ("Something went
  wrong: workflow suspended" on every turn). All three classification sites (workflow catch, the
  loop's `isControlFlowError` hook, the runner's start-suspend swallow) now use durable-core
  0.52.0's marker-based `isWorkflowControlFlowSignal` — the peer floor rises to
  `@dudousxd/nestjs-durable-core >= 0.52.0` accordingly.
- **Dashboard mounted in an Inertia host:** an Inertia `<Link>` visit to the console received plain
  HTML and rendered it inside the client's about:srcdoc error modal, where relative assets die on
  CORS. The UI controller now answers `X-Inertia` requests with the protocol's own external-redirect
  mechanism (`409` + `X-Inertia-Location`), so in-app links full-load the console correctly.
- **Approvals attribution defaults to the AgentModule-configured actor resolver** (`@Global`,
  already exported) — zero config for hosts whose console auth matches chat auth; the
  `approvalActorRef` override is now generically typed (`AgentDashboardOptions<TReq>`, mirroring
  `ActorResolver<TReq>`) for hosts where it differs.
