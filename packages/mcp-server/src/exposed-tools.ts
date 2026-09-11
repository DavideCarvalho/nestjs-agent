import type { ToolKind } from '@dudousxd/nestjs-agent-core';

/**
 * What an `action` tool means on a surface with no human on it.
 *
 * In the agent loop an `action` never auto-executes: the turn parks and waits for a person to
 * approve the call. An MCP client is a program; there is nobody to park for and nobody to ask, so
 * the approval the tool was declared to require cannot happen.
 *
 * - `'deny'` (default) — `action` tools are neither listed nor callable over MCP. The gate is kept,
 *   by keeping the tool off a surface that cannot honour it.
 * - `'execute'` — the deployment states that an MCP caller is trusted to act without approval, and
 *   `action` tools run on call. This REMOVES the human from every `action` tool the caller's roles
 *   allow; narrow it with `allowedTools` and with the roles the caller's identity carries.
 */
export type McpActionPolicy = 'deny' | 'execute';

/** Thrown when a tool is called over MCP that this surface does not expose. */
export class McpToolNotExposedError extends Error {
  constructor(
    readonly toolName: string,
    readonly reason: string,
  ) {
    super(`Tool "${toolName}" is not exposed over MCP: ${reason}`);
    this.name = 'McpToolNotExposedError';
  }
}

/** What decides whether one registered tool crosses the MCP boundary. */
export interface McpExposureInput {
  name: string;
  kind: ToolKind;
  actions: McpActionPolicy;
  /** Names this deployment exposes over MCP. `undefined` → every tool of an exposable kind. */
  allowedTools?: string[];
}

/**
 * Why this tool is NOT exposed over MCP, or `undefined` when it is. The same answer gates both
 * `tools/list` and `tools/call`, so a client holding a stale list cannot call something the list
 * would no longer contain.
 *
 * The allow-list is re-checked here because `ToolRegistry.invoke` does not know about it —
 * `definitionsFor` applies it when the list is built and nothing applies it on the way in. Without
 * this check a caller who simply guesses a name reaches a tool the deployment deliberately left off
 * its MCP surface.
 *
 * Kinds other than `read` and `action` are refused outright, whatever the policy says:
 *
 * - `agent` tools are registered with a stub handler because the LOOP performs the delegation;
 *   invoking one through the registry runs the stub, which answers `{}` and delegates to nobody.
 * - `ask`, `skill` and `memory` are served by the loop against a run and are never registered at
 *   all, so no `ToolSpec` should carry them — refusing them keeps that true of this surface even if
 *   something registers one out of band.
 */
export function mcpExposureRefusal(input: McpExposureInput): string | undefined {
  const { name, kind, actions, allowedTools } = input;
  if (allowedTools !== undefined && !allowedTools.includes(name)) {
    return 'this deployment does not list it among the tools it exposes over MCP';
  }
  if (kind === 'read') {
    return undefined;
  }
  if (kind === 'action') {
    return actions === 'execute'
      ? undefined
      : 'an "action" tool requires human approval before it runs, and an MCP caller has no human to approve it';
  }
  return `a "${kind}" tool is served by the agent loop rather than by its registered handler, so it cannot run outside a turn`;
}

/** True when this tool crosses the MCP boundary. See {@link mcpExposureRefusal}. */
export function isToolExposedOverMcp(input: McpExposureInput): boolean {
  return mcpExposureRefusal(input) === undefined;
}

/** Throw {@link McpToolNotExposedError} unless this tool crosses the MCP boundary. */
export function assertToolExposedOverMcp(input: McpExposureInput): void {
  const reason = mcpExposureRefusal(input);
  if (reason !== undefined) {
    throw new McpToolNotExposedError(input.name, reason);
  }
}
