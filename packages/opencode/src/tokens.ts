/** The host's {@link import('./host.js').OpenCodeHost}. */
export const OPENCODE_HOST = Symbol('nestjs-agent-opencode:host');
/** Where each thread's session is kept ({@link import('./host.js').OpenCodeSessionStore}). */
export const OPENCODE_SESSIONS = Symbol('nestjs-agent-opencode:sessions');
/** The engine's {@link import('./turns.js').OpenCodeEngineSettings}. */
export const OPENCODE_OPTIONS = Symbol('nestjs-agent-opencode:options');
