import { DEV_TOOLS_SLOT, type DevTool, type DevToolsLib, type DevToolsSlot } from './contract.js';
import { schemaProblem } from './schema.js';

const LIB_ID = /^[a-z][a-z0-9]*$/;
const TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** A lib as the endpoint serves it: validated, its tools already filtered by `exclude`. */
export interface ServedDevToolsLib {
  lib: string;
  title: string;
  authorize: DevToolsLib['authorize'];
  tools: DevTool[];
  /** How many tools it registered before `exclude` (for the boot log). */
  registered: number;
}

/** What one read of the slot gives: the libs served, and the ones refused with why. */
export interface DevToolsSnapshot {
  libs: ServedDevToolsLib[];
  rejected: Array<{ lib: string; problem: string }>;
}

/** Why a registered lib cannot be served, or `null`. */
export function libProblem(lib: unknown): string | null {
  if (typeof lib !== 'object' || lib === null) return 'a registered lib is not an object';
  const candidate = lib as Partial<DevToolsLib>;
  if (typeof candidate.lib !== 'string' || !LIB_ID.test(candidate.lib)) {
    return `lib id ${JSON.stringify(candidate.lib)} must match /^[a-z][a-z0-9]*$/`;
  }
  if (typeof candidate.authorize !== 'function') {
    return `the lib "${candidate.lib}" has no authorize function`;
  }
  if (!Array.isArray(candidate.tools)) return `"${candidate.lib}".tools must be an array`;
  const names = new Set<string>();
  for (const tool of candidate.tools) {
    const problem = toolProblem(candidate.lib, tool);
    if (problem !== null) return problem;
    if (names.has(tool.name)) return `the tool "${tool.name}" is registered twice`;
    names.add(tool.name);
  }
  return null;
}

function toolProblem(lib: string, tool: DevTool): string | null {
  if (typeof tool !== 'object' || tool === null) {
    return `"${lib}" registered a tool that is not an object`;
  }
  const name = tool.name;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    return `tool name ${JSON.stringify(name)} must be snake_case <lib>_<verb>_<noun>`;
  }
  if (!name.startsWith(`${lib}_`)) return `tool "${name}" must be prefixed by its lib ("${lib}_")`;
  if (tool.kind !== 'read' && tool.kind !== 'action') {
    return `tool "${name}" has kind ${JSON.stringify(tool.kind)}: use "read" or "action"`;
  }
  if (typeof tool.description !== 'string' || tool.description === '') {
    return `tool "${name}" needs a description`;
  }
  if (typeof tool.run !== 'function') return `tool "${name}" has no run()`;
  const problem = schemaProblem(tool.input);
  if (problem !== null) return `tool "${name}": ${problem}`;
  return null;
}

/** The slot as it stands, or `undefined` when nobody created it or it speaks another version. */
export function readSlot(): DevToolsSlot | undefined {
  const slot = (globalThis as Record<symbol, unknown>)[DEV_TOOLS_SLOT] as
    | Partial<DevToolsSlot>
    | undefined;
  if (slot?.version !== 1 || !Array.isArray(slot.libs)) return undefined;
  return slot as DevToolsSlot;
}

/**
 * The libs the endpoint serves right now. `exclude` holds lib ids or full tool names: an excluded
 * tool never reaches a request's server. A lib whose registration is invalid is left out whole.
 */
export function snapshot(exclude: ReadonlySet<string>): DevToolsSnapshot {
  const libs: ServedDevToolsLib[] = [];
  const rejected: DevToolsSnapshot['rejected'] = [];
  for (const lib of readSlot()?.libs ?? []) {
    const problem = libProblem(lib);
    if (problem !== null) {
      rejected.push({ lib: String((lib as { lib?: unknown })?.lib), problem });
      continue;
    }
    const tools = exclude.has(lib.lib) ? [] : lib.tools.filter((tool) => !exclude.has(tool.name));
    libs.push({
      lib: lib.lib,
      title: typeof lib.title === 'string' && lib.title !== '' ? lib.title : lib.lib,
      authorize: lib.authorize,
      tools,
      registered: lib.tools.length,
    });
  }
  return { libs, rejected };
}

/** The libs that still have tools after `exclude`. */
export function servedLibs(snap: DevToolsSnapshot): ServedDevToolsLib[] {
  return snap.libs.filter((lib) => lib.tools.length > 0);
}
