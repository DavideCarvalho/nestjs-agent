/**
 * `AgentService`, as the controllers of a secondary entry (`@dudousxd/nestjs-agent/a2ui`) ask for it.
 *
 * A token rather than the class: every entry is its own bundle with its own copy of every class it
 * imports, so the class used as an injection token there is not the one `AgentModule` provides.
 * `Symbol.for` is the same value in every bundle.
 */
export const AGENT_SERVICE = Symbol.for('@dudousxd/nestjs-agent:agent-service');
