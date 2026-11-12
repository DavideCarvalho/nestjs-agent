/** What `actions` in `devTools` may say: none, all, or these lib ids / tool names. */
export type DevToolsActions = 'refuse' | 'execute' | string[];

/** The dev MCP endpoint's settings (`AgentMcpServerModule.forRoot({ devTools })`). */
export interface AgentDevToolsOptions {
  /** Route the dev endpoint mounts at. Default `'mcp/aviary'`. Must differ from the product `path`. */
  path?: string;
  /** Lib ids or full tool names left out: `['durable', 'agent_get_spend']`. */
  exclude?: string[];
  /**
   * Which `action` tools are listed and callable. `'refuse'` (default): none. `'execute'`: all. A
   * list: the actions of these lib ids, or these tool names. The product endpoint's `actions` never
   * applies here.
   */
  actions?: DevToolsActions;
  /**
   * Class decorators added to the dev endpoint's controller before its own access check, e.g. a
   * guard that sets `request.user`, or a rate limit. Static.
   */
  decorators?: ClassDecorator[];
}

/** The dev endpoint's options once defaults are applied. */
export interface ResolvedDevToolsOptions {
  path: string;
  exclude: ReadonlySet<string>;
  actions: DevToolsActions;
}

/** Default route of the dev endpoint. */
export const DEFAULT_DEV_TOOLS_PATH = 'mcp/aviary';

export function trimPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/** Whether `actions` lets this action tool be listed and called. */
export function actionAllowed(actions: DevToolsActions, lib: string, tool: string): boolean {
  if (actions === 'execute') return true;
  if (actions === 'refuse') return false;
  return actions.includes(lib) || actions.includes(tool);
}

/**
 * The dev endpoint's resolved options, or `undefined` for `devTools: false`. Throws when its path is
 * the product endpoint's: the two must never share a route.
 */
export function resolveDevToolsOptions(
  devTools: false | AgentDevToolsOptions | undefined,
  productPath: string | false,
): ResolvedDevToolsOptions | undefined {
  if (devTools === false) return undefined;
  const path = trimPath(devTools?.path ?? DEFAULT_DEV_TOOLS_PATH);
  if (path === '') throw new Error('AgentMcpServerModule: `devTools.path` must not be empty.');
  if (productPath !== false && trimPath(productPath) === path) {
    throw new Error(
      `AgentMcpServerModule: \`devTools.path\` "${path}" is the MCP endpoint's own path. The dev endpoint needs a route of its own.`,
    );
  }
  const actions = devTools?.actions ?? 'refuse';
  if (
    actions !== 'refuse' &&
    actions !== 'execute' &&
    !(Array.isArray(actions) && actions.every((entry) => typeof entry === 'string'))
  ) {
    throw new Error(
      'AgentMcpServerModule: `devTools.actions` must be "refuse", "execute" or a list of lib ids / tool names.',
    );
  }
  return { path, exclude: new Set(devTools?.exclude ?? []), actions };
}
