/**
 * DI flag mirroring `AgentModuleOptions.dispatchedSteps`: whether `AgentRunWorkflow` dispatches its
 * `llm`/`tool` steps as routed remote steps (`AgentRunSteps`) instead of in-process `ctx.localStep`s.
 * `AgentDurableModule` binds it from `AGENT_OPTIONS` (defaulting to `false`); `AgentRunWorkflow`
 * injects it. Kept in its own file — `AgentDurableModule` provides `AgentRunWorkflow` and
 * `AgentRunWorkflow` injects this token, so declaring it in either of those two files would make them
 * import each other.
 */
export const AGENT_DISPATCHED_STEPS = Symbol.for('@dudousxd/nestjs-agent:dispatched-steps');
