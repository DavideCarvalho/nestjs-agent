import type { ExecutionContext } from '@nestjs/common';

/**
 * The dev-tools registration contract, version 1.
 *
 * Every Aviary lib with a console registers its developer tools into ONE process-wide slot,
 * `globalThis[Symbol.for('@dudousxd/aviary:dev-tools')]`, from its `onModuleInit`. The agent's MCP
 * server reads the slot at request time and serves the tools on one dev endpoint (`/mcp/aviary`).
 *
 * The contract is STRUCTURAL: a lib re-declares these types (and {@link registerDevTools}) and never
 * imports this package, which stays an optional, undeclared peer. Only additive changes are made
 * under `version: 1`.
 */

/** The registry symbol the slot lives at. */
export const DEV_TOOLS_SLOT = Symbol.for('@dudousxd/aviary:dev-tools');

/** The contract version a lib checks before registering. */
export const DEV_TOOLS_VERSION = 1;

/** The slot: data only. Whoever loads first creates it. */
export interface DevToolsSlot {
  readonly version: 1;
  readonly libs: DevToolsLib[];
  /** Adds a lib. Throws on a duplicate lib id. Returns a function that removes it again. */
  register(lib: DevToolsLib): () => void;
}

/**
 * What a lib's `authorize` answers: the consoles' resolved decision. An allow may name who was let
 * in (`caller`), for the audit trail: a token form answers `token:<first 12 hex of sha256(token)>`,
 * never the token; the open default (no `authorize`, outside production) answers `dev-open`.
 * Without it, the endpoint uses `request.user.id`, else `session`.
 */
export type DevToolsDecision =
  | { allowed: true; caller?: string }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/** One lib's tools and the gate that decides who may use them. */
export interface DevToolsLib {
  /** `/^[a-z][a-z0-9]*$/`: `'durable'`, `'telescope'`, `'agent'`, … */
  lib: string;
  /** Human title, used in the endpoint's instructions (`'Agent governance'`). */
  title: string;
  /**
   * The lib's RESOLVED console gate: the same function its console routes call, run once per MCP
   * request with the MCP request's own `ExecutionContext`. Never throws (a throw is `forbidden`).
   */
  authorize(context: ExecutionContext): Promise<DevToolsDecision>;
  tools: DevTool[];
}

/** One developer tool. */
export interface DevTool {
  /** Full name, prefixed by the lib: `agent_list_runs`. `<lib>_<verb>_<noun>`, snake_case. */
  name: string;
  /** `read` tools are listed by default; `action` tools only when the app opts in. */
  kind: 'read' | 'action';
  /** Agent-facing: what it returns, and its limits. */
  description: string;
  /** JSON Schema subset, see {@link DevToolInputSchema}. */
  input: DevToolInputSchema;
  /** Annotation for actions that cancel, refund, revoke or delete. */
  destructive?: boolean;
  /** Capability, NOT access: hide a tool this deployment cannot run. */
  available?(): boolean | Promise<boolean>;
  /** Runs the tool. The input is already validated against `input`. */
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  /** The MCP request's own execution context. */
  context: ExecutionContext;
  caller: DevToolsCaller;
  limits: { maxRows: number; maxBytes: number };
}

/** Who is calling, for audit trails. Never a token value. */
export interface DevToolsCaller {
  /** `'token:3f9a1c2b7d10'`, `'user:42'`, `'session'`, `'dev-open'`. */
  id: string;
  via: 'token' | 'session' | 'open';
}

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  /** Arrays hold strings only. */
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** An object of scalar / enum / array-of-string properties: what console query strings already are. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

/**
 * The slot, created when absent. A lib that has no access to this package copies this function (it
 * is the whole integration, with {@link registerDevTools}).
 */
export function devToolsSlot(): DevToolsSlot {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[DEV_TOOLS_SLOT] as DevToolsSlot | undefined;
  if (existing !== undefined) return existing;
  const libs: DevToolsLib[] = [];
  const slot: DevToolsSlot = {
    version: 1,
    libs,
    register(lib) {
      if (libs.some((entry) => entry.lib === lib.lib)) {
        throw new Error(`dev tools: the lib "${lib.lib}" is already registered`);
      }
      libs.push(lib);
      return () => {
        const index = libs.indexOf(lib);
        if (index !== -1) libs.splice(index, 1);
      };
    },
  };
  holder[DEV_TOOLS_SLOT] = slot;
  return slot;
}

/**
 * Register a lib's tools into the slot, creating it when absent. Returns the function that removes
 * them (call it from `onModuleDestroy`), or `undefined` when the slot speaks another version.
 */
export function registerDevTools(lib: DevToolsLib): (() => void) | undefined {
  const slot = devToolsSlot() as Partial<DevToolsSlot>;
  if (slot.version !== DEV_TOOLS_VERSION || typeof slot.register !== 'function') return undefined;
  return slot.register(lib);
}
