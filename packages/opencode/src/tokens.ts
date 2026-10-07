// `Symbol.for`: the main and the `/durable` bundles each carry their own copy of this module (and of
// the classes), so tokens must be the same symbol in both — a host resolves the engine's services
// through these, never by class.

/** The host's {@link import('./host.js').OpenCodeHost}. */
export const OPENCODE_HOST = Symbol.for('@dudousxd/nestjs-agent-opencode:host');
/** Where each thread's session is kept ({@link import('./host.js').OpenCodeSessionStore}). */
export const OPENCODE_SESSIONS = Symbol.for('@dudousxd/nestjs-agent-opencode:sessions');
/** The engine's {@link import('./turns.js').OpenCodeEngineSettings}. */
export const OPENCODE_OPTIONS = Symbol.for('@dudousxd/nestjs-agent-opencode:options');
/**
 * The engine's turn steps ({@link import('./turns.js').OpenCodeTurns}): `callContext` for the MCP
 * surface, `pushToSession`, `liveRuns`. Inject this token, not the class — the class a host imports
 * from the main bundle is not the one `openCodeDurable()` (`/durable`) registers.
 */
export const OPENCODE_TURNS = Symbol.for('@dudousxd/nestjs-agent-opencode:turns');
/** The engine's tools endpoint ({@link import('./mcp.js').OpenCodeMcpEndpoint}), when `tools` is set. */
export const OPENCODE_MCP_ENDPOINT = Symbol.for('@dudousxd/nestjs-agent-opencode:mcp-endpoint');
/** Mints and checks the tools endpoint's bearer tokens ({@link import('./mcp.js').OpenCodeToolsTokens}). */
export const OPENCODE_TOOLS_TOKENS = Symbol.for('@dudousxd/nestjs-agent-opencode:tools-tokens');
