/**
 * DI flag carrying the EFFECTIVE `dispatchedSteps` value: whether `AgentRunWorkflow` dispatches its
 * `llm`/`tool` steps as routed remote steps (`AgentRunSteps`) instead of in-process `ctx.localStep`s.
 * `AgentDurableModule` derives it from `AGENT_OPTIONS` (`durable === true && dispatchedSteps !==
 * false` — default ON under durable); `AgentRunWorkflow` injects it. Kept in its own file —
 * `AgentDurableModule` provides `AgentRunWorkflow` and `AgentRunWorkflow` injects this token, so
 * declaring it in either of those two files would make them import each other.
 */
export const AGENT_DISPATCHED_STEPS = Symbol.for('@dudousxd/nestjs-agent:dispatched-steps');
