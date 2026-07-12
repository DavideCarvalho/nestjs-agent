/**
 * DI tokens for the standalone AI-gateway dashboard.
 *
 * All use `Symbol.for(...)` (the global symbol registry) on purpose: pnpm peer multiplexing + dual
 * ESM/CJS can load a package more than once, and a plain `Symbol()` would mint a distinct token per
 * copy and break DI across the ESM/CJS split. A registered symbol collapses every copy onto the same
 * token.
 */

/**
 * The governance read-model, owned by `@dudousxd/nestjs-agent-core`. We re-declare it here BY VALUE
 * (not by import) so DI does not depend on a runtime value-import of core resolving — `Symbol.for`
 * with the identical key resolves to the SAME symbol instance as core's own
 * `packages/core/src/tokens.ts` export. The key MUST stay byte-identical with that export.
 */
export const AGENT_GOVERNANCE_QUERIES = Symbol.for('@dudousxd/nestjs-agent:governance-queries');

/**
 * Optional actor→label resolver (see {@link ActorDirectory} in `./actor-directory.js`), owned by
 * `@dudousxd/nestjs-agent-core`. Re-declared here BY VALUE for the same reason as
 * {@link AGENT_GOVERNANCE_QUERIES} above — the key MUST stay byte-identical with core's own
 * `AGENT_ACTOR_DIRECTORY` export so both copies collapse onto the same registered symbol. Optional:
 * the dashboard works with actorRef-only rows when nothing is bound.
 */
export const AGENT_ACTOR_DIRECTORY = Symbol.for('@dudousxd/nestjs-agent:actor-directory');

/**
 * The pricing WRITE side (`AgentPricingStore`), owned by `@dudousxd/nestjs-agent-core`. Re-declared
 * here BY VALUE for the same reason as {@link AGENT_GOVERNANCE_QUERIES} above. Optional: the pricing
 * tab/endpoints 501 with a clear message when nothing is bound.
 */
export const AGENT_PRICING_STORE = Symbol.for('@dudousxd/nestjs-agent:pricing-store');

/**
 * Console-side HITL decisions (`AgentApprovalPort`), owned by `@dudousxd/nestjs-agent-core`.
 * Re-declared here BY VALUE for the same reason as {@link AGENT_GOVERNANCE_QUERIES} above. Optional:
 * bound by `@dudousxd/nestjs-agent` (which adapts it to the same signal path chat approvals use) —
 * absent, `POST <api>/approvals/:toolCallId` 501s and the approvals inbox renders read-only.
 */
export const AGENT_APPROVAL_PORT = Symbol.for('@dudousxd/nestjs-agent:approval-port');

/**
 * The app's request-identity seam (`ActorResolver`), owned by `@dudousxd/nestjs-agent-core` and
 * bound + exported by the (global) `AgentModule` from the host's `actorResolver` option. Re-declared
 * here BY VALUE for the same reason as {@link AGENT_GOVERNANCE_QUERIES} above. Optional: the default
 * decider attribution for `POST <api>/approvals/:toolCallId` — absent (or throwing, i.e.
 * unauthenticated), `executedByRef` is simply omitted.
 */
export const AGENT_ACTOR_RESOLVER = Symbol.for('@dudousxd/nestjs-agent:actor-resolver');

/** DI token carrying the UI mount base (e.g. `/ai-gateway`). */
export const DASHBOARD_BASE_PATH = Symbol.for('@dudousxd/nestjs-agent-dashboard:base-path');

/** DI token carrying the JSON API base the SPA fetches from (e.g. `/ai-gateway/api`). */
export const DASHBOARD_API_PATH = Symbol.for('@dudousxd/nestjs-agent-dashboard:api-path');

/**
 * DI token carrying the host-provided {@link AgentDashboardOptions.approvalActorRef} extractor (or
 * `undefined` when the host didn't set one — the controller then falls back to
 * {@link AGENT_ACTOR_RESOLVER} for decider attribution). Threaded to `AgentApiModule` (where the API
 * controller actually lives) same as the pattern above — `useValue` even when `undefined`, so
 * injecting it needs no `@Optional()` (mirrors `AGENT_QUOTA_STORE`'s factory in
 * `@dudousxd/nestjs-agent`).
 */
export const DASHBOARD_APPROVAL_ACTOR_REF = Symbol.for(
  '@dudousxd/nestjs-agent-dashboard:approval-actor-ref',
);
