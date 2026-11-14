import { type DevToolsActions, isActionsMap } from './actions.js';
import type { ConsoleAuthorize } from './endpoint-authorize.js';

export type {
  DevToolsActionRequest,
  DevToolsActions,
  DevToolsActionsAuthorizer,
  DevToolsActionsMap,
} from './actions.js';

/** The dev MCP endpoint's settings (`AgentMcpServerModule.forRoot({ devTools })`). */
export interface AgentDevToolsOptions {
  /** Route the dev endpoint mounts at. Default `'mcp/aviary'`. Must differ from the product `path`. */
  path?: string;
  /** Lib ids or full tool names left out: `['durable', 'agent_get_spend']`. */
  exclude?: string[];
  /**
   * Which `action` tools (retry, cancel, refund…) each request gets, decided per request: a refused
   * action is neither listed nor callable, and a lib's own console `authorize` still gates the lib
   * first. The product endpoint's `actions` never applies here.
   * - `'refuse'` (default): none; `'execute'`: all; `['durable', 'payments_refund_payment']`: those.
   * - a map of lib ids / tool names to a console `authorize` (a function, a class, a lazy import,
   *   `{ policy, ability }` or a gate name). A tool-name key wins over its lib's; an action in
   *   neither is refused; a throw, `{ redirectTo }` or `unauthenticated` refuses. Each distinct
   *   `authorize` runs once per request.
   * - a function `(request, { lib, tool, destructive, caller }) => boolean`. Anything but `true`, or
   *   a throw, refuses.
   *
   * ```ts
   * actions: {
   *   durable: authorizeByToken({ token: process.env.DEV_TOOLS_TOKEN }),
   *   durable_cancel_run: (ctx) => ctx.switchToHttp().getRequest().user?.role === 'owner',
   *   payments_refund_payment: () => false,
   * },
   * ```
   */
  actions?: DevToolsActions;
  /**
   * Class decorators added to the dev endpoint's controller before its own access check, e.g. a
   * guard that sets `request.user`, or a rate limit. Static.
   */
  decorators?: ClassDecorator[];
  /**
   * The gate for libs that register dev tools WITHOUT a console of their own (resilience, authz,
   * diagnostics, filter): any form a console's `authorize` takes (a function, a class, a lazy import,
   * `{ policy, ability }` or a gate name), run at most once per request. Libs with a console keep
   * their own gate; this never widens them. Omit → those libs are open outside production and
   * denied in production, with one boot warning.
   */
  authorize?: ConsoleAuthorize;
}

/** The dev endpoint's options once defaults are applied. */
export interface ResolvedDevToolsOptions {
  path: string;
  exclude: ReadonlySet<string>;
  actions: DevToolsActions;
  /** `devTools.authorize`, resolved by the endpoint at boot. */
  authorize?: ConsoleAuthorize;
}

/** Default route of the dev endpoint. */
export const DEFAULT_DEV_TOOLS_PATH = 'mcp/aviary';

export function trimPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
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
    typeof actions !== 'function' &&
    !isActionsMap(actions) &&
    !(Array.isArray(actions) && actions.every((entry) => typeof entry === 'string'))
  ) {
    throw new Error(
      'AgentMcpServerModule: `devTools.actions` must be "refuse", "execute", a list of lib ids / tool names, a map of lib ids / tool names to an `authorize`, or a function.',
    );
  }
  return {
    path,
    exclude: new Set(devTools?.exclude ?? []),
    actions,
    ...(devTools?.authorize !== undefined ? { authorize: devTools.authorize } : {}),
  };
}
