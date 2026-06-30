import type { RolesPolicy } from './spi/roles-policy.js';
import type { Actor, ToolSpec } from './types.js';

/** First filter layer: drop tools the actor's role may not invoke. */
export function filterToolsByRole(
  tools: ToolSpec[],
  actor: Actor,
  policy: RolesPolicy,
): ToolSpec[] {
  return tools.filter((tool) => policy.can(actor, tool));
}

/** Second filter layer: if the persona pins an allow-list, keep only those tool names. */
export function personaFilterTools(
  tools: ToolSpec[],
  allowedTools: string[] | undefined,
): ToolSpec[] {
  if (allowedTools === undefined) {
    return tools;
  }
  const allowed = new Set(allowedTools);
  return tools.filter((tool) => allowed.has(tool.name));
}
