/**
 * Public, cross-lib-discoverable DI tokens.
 *
 * These use `Symbol.for(...)` (the global symbol registry) on purpose: pnpm peer
 * multiplexing + dual ESM/CJS can load `core` more than once, and a plain `Symbol()`
 * would mint a distinct token per copy and break DI across package boundaries. A
 * registered symbol collapses every copy onto the same token, and lets a sibling lib
 * resolve our injectables by name without importing our internals.
 *
 * Naming convention (ecosystem-wide): `@dudousxd/nestjs-<lib>:<name>`.
 */
export const AGENT_OPTIONS = Symbol.for('@dudousxd/nestjs-agent:options');
export const AGENT_STORE = Symbol.for('@dudousxd/nestjs-agent:store');
export const AGENT_RUNNER = Symbol.for('@dudousxd/nestjs-agent:runner');
/**
 * The durable runner, provided ONLY by `AgentDurableModule`. When `durable: true`, the module
 * binds `AGENT_RUNNER` to this via an optional injection, so a missing `AgentDurableModule`
 * fails with a clear error instead of a cryptic unresolved-dependency one.
 */
export const AGENT_DURABLE_RUNNER = Symbol.for('@dudousxd/nestjs-agent:durable-runner');
export const AGENT_SINK = Symbol.for('@dudousxd/nestjs-agent:sink');
export const AGENT_MODEL = Symbol.for('@dudousxd/nestjs-agent:model');
export const AGENT_ROLES_POLICY = Symbol.for('@dudousxd/nestjs-agent:roles-policy');
export const AGENT_QUOTA_STORE = Symbol.for('@dudousxd/nestjs-agent:quota-store');
export const AGENT_TOOL_REGISTRY = Symbol.for('@dudousxd/nestjs-agent:tool-registry');
export const AGENT_REGISTRY = Symbol.for('@dudousxd/nestjs-agent:agent-registry');
export const AGENT_ACTOR_RESOLVER = Symbol.for('@dudousxd/nestjs-agent:actor-resolver');
/** The governance read-model (usage/spend/threads), consumed by the dashboard + telescope surfaces. */
export const AGENT_GOVERNANCE_QUERIES = Symbol.for('@dudousxd/nestjs-agent:governance-queries');
/** The pricing WRITE side (`AgentPricingStore`) — seeds/updates the per-model rates cost is priced against. */
export const AGENT_PRICING_STORE = Symbol.for('@dudousxd/nestjs-agent:pricing-store');
/** The RAG retrieval seam (`Retriever`) — vector/keyword search behind the agentic tool or inject mode. */
export const AGENT_RETRIEVER = Symbol.for('@dudousxd/nestjs-agent:retriever');
/** The embedding provider (`EmbeddingProvider`) — text→vector for retrieval + ingestion. */
export const AGENT_EMBEDDING_PROVIDER = Symbol.for('@dudousxd/nestjs-agent:embedding-provider');
// Per-agent deps factory. A Symbol.for token (not the class) so DI survives tsup's dual
// index/durable bundles, which each get their own copy of the AgentDepsFactory class.
export const AGENT_DEPS_FACTORY = Symbol.for('@dudousxd/nestjs-agent:deps-factory');
/** App-wide, ordered `@SystemPromptContributor()` functions the loop appends after the agent base. */
export const AGENT_PROMPT_CONTRIBUTORS = Symbol.for('@dudousxd/nestjs-agent:prompt-contributors');
/**
 * Resolves opaque store `actorRef`s to human display labels for governance/dashboard read surfaces.
 * Optional — see {@link import('./spi/actor-directory.js').ActorDirectory}.
 */
export const AGENT_ACTOR_DIRECTORY = Symbol.for('@dudousxd/nestjs-agent:actor-directory');
/**
 * Persists an uploaded attachment somewhere the model can fetch it from and returns a
 * `MessageAttachment`. Optional — see
 * {@link import('./spi/attachment-staging.js').AttachmentStagingStore}.
 */
export const AGENT_ATTACHMENT_STAGING = Symbol.for('@dudousxd/nestjs-agent:attachment-staging');
/**
 * Console-side HITL approve/reject for the cross-thread approvals inbox. Optional — see
 * {@link import('./spi/approval-port.js').AgentApprovalPort}.
 */
export const AGENT_APPROVAL_PORT = Symbol.for('@dudousxd/nestjs-agent:approval-port');
/**
 * The resolved `SkillsConfig` (provider + scope resolver + ceiling), or `undefined` where the host
 * configured no skills. Bound once and read by BOTH the loop's deps and the listing endpoint, so
 * what a user can invoke and what the model can reach are the same resolution.
 */
export const AGENT_SKILLS = Symbol.for('@dudousxd/nestjs-agent:skills');
/**
 * The resolved `MemoryConfig` (provider + scope resolver + ceilings), or `undefined` where the host
 * configured no memory. Bound once and read by BOTH the loop's deps and the read-back endpoint, so
 * what a person is shown and what the model was shown are the same resolution.
 */
export const AGENT_MEMORY = Symbol.for('@dudousxd/nestjs-agent:memory');
/**
 * A shared, mutable list `SkillDiscoveryService` fills with `@Skill`-decorated providers. Read
 * lazily by the bound {@link AGENT_SKILLS} provider — discovery runs after DI has built it.
 */
export const AGENT_SKILL_SOURCES = Symbol.for('@dudousxd/nestjs-agent:skill-sources');
