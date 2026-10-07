/**
 * `Symbol.for(...)` for the same reason core's tokens use it: pnpm peer multiplexing plus a dual
 * ESM/CJS build can load this package more than once, and a plain `Symbol()` would mint a distinct
 * token per copy.
 */
export const AGENT_CHANNELS_OPTIONS = Symbol.for('@dudousxd/nestjs-agent-channels:options');
