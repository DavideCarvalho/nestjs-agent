import type { RolesPolicy } from './spi/roles-policy.js';
import type { Actor, ToolSpec } from './types.js';

/** First filter layer: drop tools the actor's role may not invoke. `can` may be async (authz). */
export async function filterToolsByRole(
  tools: ToolSpec[],
  actor: Actor,
  policy: RolesPolicy,
): Promise<ToolSpec[]> {
  const checked = await Promise.all(
    tools.map(async (tool) => ({ tool, allowed: await policy.can(actor, tool) })),
  );
  return checked.filter((entry) => entry.allowed).map((entry) => entry.tool);
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
