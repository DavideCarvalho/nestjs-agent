import type { ToolPresentation } from '@dudousxd/nestjs-agent-core';
import type {
  Catalog,
  GenuiCatalogScope,
  GenuiChannels,
  GenuiStreaming,
  GenuiToolsOptions,
  SandboxClientConfig,
  TreeLimits,
  TreeSchemaMode,
} from '@dudousxd/nestjs-agent-core/genui';
import {
  type DefineSandboxOptions,
  assertGenuiChannels,
  defineCatalog,
  defineSandbox,
  genuiTools,
} from '@dudousxd/nestjs-agent-core/genui';
import {
  type DynamicModule,
  type FactoryProvider,
  Inject,
  Module,
  type ModuleMetadata,
  type Provider,
  type Type,
} from '@nestjs/common';
import { provideAgentTools } from '../functional-tool.js';
import { AGENT_GENUI, AgentGenui } from './agent-genui.token.js';

export { AGENT_GENUI, AgentGenui } from './agent-genui.token.js';

/** The app's genui catalog — `@InjectGenuiCatalog()` it anywhere; `overrideProvider` it in tests. */
export const GENUI_CATALOG = Symbol.for('@dudousxd/nestjs-agent:genui-catalog');

/** The resolved {@link AgentGenuiOptions} (without the resolver). */
export const GENUI_OPTIONS = Symbol.for('@dudousxd/nestjs-agent:genui-options');

/** The sandbox and channels as boot resolved them (kit, Tailwind and theme found). Internal. */
const GENUI_RESOLVED = Symbol.for('@dudousxd/nestjs-agent:genui-resolved');

/** Inject the app's genui catalog ({@link GENUI_CATALOG}). */
export const InjectGenuiCatalog = (): ParameterDecorator & PropertyDecorator =>
  Inject(GENUI_CATALOG);

/**
 * Picks the catalog for ONE request — a tenant's own, versioned components. Consulted when a genui
 * call is validated and when the turn's tool list is described to the model, so components can
 * change without rebuilding tools at boot. Cache in here if resolving costs a round trip: it runs
 * once per turn per genui tool, and once per call.
 *
 * Provide it through `AgentGenuiModule.forRoot({ resolver })` (a class, resolved with DI, or an
 * instance); it is then injectable, and replaceable in a test with
 * `overrideProvider(GenuiCatalogResolver)`.
 */
export abstract class GenuiCatalogResolver {
  abstract resolve(scope: GenuiCatalogScope): Catalog | Promise<Catalog>;
}

/** What {@link AgentGenuiModule} builds tools from. */
export interface AgentGenuiOptions {
  /**
   * The catalog. With a {@link GenuiCatalogResolver} it is the boot-time one — it names the
   * per-component tools — and may be empty. Default: an empty catalog.
   */
  catalog?: Catalog;
  /**
   * `tree` (default): one `ui__render` tool taking a composed tree (a single node is pushed as that
   * component). `per-component`: one `ui__show_<snake>` tool per component.
   */
  mode?: 'per-component' | 'tree';
  /** `ui__render`'s input schema: `'strict'` (default, a `$defs` union per component) or `'loose'`. */
  treeSchema?: TreeSchemaMode;
  /**
   * Tree mode: `'complete'` (default) draws the tree once the call has run; `'partial'` streams it
   * as `partial` ui frames while the model writes it. A component's own `streaming` overrides it.
   */
  streaming?: GenuiStreaming;
  /** Least time between two partial tree frames of one call, in ms. Default 100. */
  streamingThrottleMs?: number;
  /** End the model's turn once a genui call succeeds (no narrating follow-up call). */
  terminal?: boolean;
  /** Tool name in `tree` mode. Default `ui__render`. */
  treeToolName?: string;
  /** Text prepended to the tree tool's description. */
  treeInstructions?: string;
  treeLimits?: TreeLimits;
  /**
   * Tree mode: components that ALSO get a flat tool whose input IS their props —
   * `componentTools: ['Sandbox']` adds `ui__sandbox`, so a model writing a big component on its own
   * has no `{ type, props }` envelope to leave out.
   */
  componentTools?: readonly string[];
  /** Tool-name prefix for `componentTools`. Default `ui__` (`Sandbox` → `ui__sandbox`). */
  componentToolPrefix?: string;
  /** Tool-name prefix in `per-component` mode. Default `ui__show_`. */
  namePrefix?: string;
  /**
   * Also register ONE generic tool taking `{ component, props }`, validated against the request's
   * catalog — how a model reaches a tenant's own components, which no boot-time tool names. `true`
   * names it `ui__show`.
   */
  showTool?: boolean | string;
  /** Text prepended to the show tool's description. */
  showInstructions?: string;
  /** Roles allowed to call the tools. Undefined → the roles policy default. */
  roles?: string[];
  /** Override the generated presentation per component (or per tree / show tool name). */
  presentation?: (component: string) => ToolPresentation | undefined;
  /**
   * Add the sandbox component (`Sandbox`): the model may write HTML, CSS and JS for a one-off
   * interactive answer when no catalog component fits. `true` for the defaults (no network), or
   * the {@link DefineSandboxOptions} (a policy listing origins, extra instructions). Off by default.
   * The browser's catalog should carry the same definition (`defineSandbox(...)` in the shared
   * catalog file) so the renderer enforces the same policy.
   *
   * `theme` (default on), `tailwind` and `kit` put the app's design system in the frame. `kit: true`
   * (and the theme's variable names) are found through `sandboxKit`: the descriptor
   * `genuiSandboxKit()` (`@dudousxd/nestjs-agent/vite`) writes in dev, the Vite manifest in
   * production — and `GET <base>/config` tells the renderer where the assets are.
   */
  sandbox?: boolean | DefineSandboxOptions;
  /**
   * Per-channel generative UI: each entry sets the mode, streaming, sandbox and rendering of one
   * channel (`web`, `mobile`, `whatsapp`, `telegram`, `email`, or `default` for the rest), over the
   * top-level options. A text channel (`@dudousxd/nestjs-agent-channels`) configured here draws the
   * components natively (reply buttons, lists, images). Omitted → every channel is served by the
   * top-level options, as before.
   */
  channels?: GenuiChannels;
  /**
   * Where the sandbox kit is found (with `sandbox: { kit: true }`, `tailwind: true` or the theme's
   * names). No Vite runs in the Nest process, so: the descriptor the dev plugin writes, else the
   * production Vite manifest (read first when `NODE_ENV=production`).
   */
  sandboxKit?: AgentGenuiSandboxKitOptions;
}

/** {@link AgentGenuiOptions.sandboxKit}. Relative paths resolve against `root`. */
export interface AgentGenuiSandboxKitOptions {
  /** Default `process.cwd()`. */
  root?: string;
  /** The dev descriptor `genuiSandboxKit()` writes. Default `.genui/sandbox-kit.json`. */
  descriptor?: string;
  /**
   * The production Vite manifest, and the directory its `file`s are relative to. Default
   * `{ file: 'public/.vite/manifest.json', outDir: 'public' }`; `false` → none.
   */
  manifest?: { file: string; outDir: string } | false;
  /** An explicit kit url (an SPA served from elsewhere), over what is found. */
  kitUrl?: string;
  /** Read the manifest first. Default: `NODE_ENV === 'production'`. */
  production?: boolean;
}

type ResolverOption = Type<GenuiCatalogResolver> | GenuiCatalogResolver;

export interface AgentGenuiModuleOptions extends AgentGenuiOptions {
  /** Per-request catalogs. A class is instantiated with DI (its dependencies must be global or exported to the root). */
  resolver?: ResolverOption;
}

export interface AgentGenuiModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  useFactory: (...deps: any[]) => AgentGenuiOptions | Promise<AgentGenuiOptions>;
  /** Per-request catalogs. A class resolves its dependencies from `imports`. */
  resolver?: ResolverOption;
}

function resolverProviders(resolver: ResolverOption | undefined): Provider[] {
  if (resolver === undefined) return [];
  return [
    typeof resolver === 'function'
      ? { provide: GenuiCatalogResolver, useClass: resolver }
      : { provide: GenuiCatalogResolver, useValue: resolver },
  ];
}

/** The sandbox and channels with the kit, Tailwind and theme names found ({@link GENUI_RESOLVED}). */
interface ResolvedGenui {
  sandbox?: boolean | DefineSandboxOptions;
  channels?: GenuiChannels;
  sandboxClient?: () => SandboxClientConfig;
}

/** What every configured sandbox (top level and channels) needs from the browser, together. */
function mergeSandboxClients(clients: Array<() => SandboxClientConfig>): SandboxClientConfig {
  const merged: SandboxClientConfig = { theme: false };
  for (const client of clients) {
    const one = client();
    merged.theme ||= one.theme;
    if (one.tailwind !== undefined) merged.tailwind ??= one.tailwind;
    if (one.kit !== undefined) merged.kit ??= one.kit;
  }
  return merged;
}

/** Resolve the sandbox (top level and per channel) against the kit discovery. */
async function resolveGenui(options: AgentGenuiOptions): Promise<ResolvedGenui> {
  const { sandbox: asked, channels: askedChannels } = options;
  assertGenuiChannels(askedChannels);
  // A sandbox's kit, Tailwind and theme names are found through the app's Vite output.
  const clients: Array<() => SandboxClientConfig> = [];
  let discovery: import('@dudousxd/nestjs-agent-core/genui/kit').SandboxKitDiscovery | undefined;
  const resolveSandbox = async (
    value: boolean | DefineSandboxOptions | undefined,
  ): Promise<boolean | DefineSandboxOptions | undefined> => {
    if (value === undefined || value === false) return value;
    // Node-only, and only with a sandbox: loaded when one is configured.
    const [{ nestSandboxKitDiscovery }, { resolveSandboxServer }] = await Promise.all([
      import('./kit.js'),
      import('@dudousxd/nestjs-agent-core/genui/kit'),
    ]);
    discovery ??= nestSandboxKitDiscovery(options.sandboxKit);
    const resolved = resolveSandboxServer(value, discovery);
    clients.push(resolved.client);
    return resolved.define;
  };
  const sandbox = await resolveSandbox(asked);
  let channels: GenuiChannels | undefined;
  if (askedChannels !== undefined) {
    channels = {};
    for (const [name, entry] of Object.entries(askedChannels)) {
      if (entry === undefined) continue;
      const own = await resolveSandbox(entry.sandbox);
      channels[name] = { ...entry, ...(own !== undefined ? { sandbox: own } : {}) };
    }
  }
  return {
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(clients.length > 0 ? { sandboxClient: () => mergeSandboxClients(clients) } : {}),
  };
}

function perRequest(
  resolver: GenuiCatalogResolver | undefined,
): GenuiToolsOptions['resolveCatalog'] | undefined {
  return resolver === undefined ? undefined : (scope: GenuiCatalogScope) => resolver.resolve(scope);
}

function toolOptions(
  options: AgentGenuiOptions,
  resolved: ResolvedGenui,
  resolver: GenuiCatalogResolver | undefined,
): GenuiToolsOptions {
  const {
    catalog: _catalog,
    sandbox: _sandbox,
    channels: _channels,
    sandboxKit: _sandboxKit,
    ...rest
  } = options;
  const resolveCatalog = perRequest(resolver);
  return {
    ...rest,
    ...(resolved.channels !== undefined ? { channels: resolved.channels } : {}),
    ...(resolved.sandbox !== undefined ? { sandbox: resolved.sandbox } : {}),
    ...(resolveCatalog !== undefined ? { resolveCatalog } : {}),
  };
}

/** The configured catalog, with the sandbox component added when `sandbox` asks for it. */
function withSandbox(options: AgentGenuiOptions, resolved: ResolvedGenui): Catalog {
  const base = options.catalog ?? defineCatalog([]);
  const { sandbox } = resolved;
  return sandbox === undefined || sandbox === false
    ? base
    : base.extend([defineSandbox(sandbox === true ? {} : sandbox)]);
}

function coreProviders(resolver: ResolverOption | undefined): Provider[] {
  return [
    {
      provide: GENUI_RESOLVED,
      useFactory: (options: AgentGenuiOptions) => resolveGenui(options),
      inject: [GENUI_OPTIONS],
    },
    {
      provide: GENUI_CATALOG,
      useFactory: (options: AgentGenuiOptions, resolved: ResolvedGenui) =>
        withSandbox(options, resolved),
      inject: [GENUI_OPTIONS, GENUI_RESOLVED],
    },
    {
      provide: AGENT_GENUI,
      useFactory: (
        options: AgentGenuiOptions,
        catalog: Catalog,
        resolved: ResolvedGenui,
        resolverInstance?: GenuiCatalogResolver,
      ) =>
        new AgentGenui(
          catalog,
          perRequest(resolverInstance),
          resolved.channels,
          {
            ...(options.mode !== undefined ? { mode: options.mode } : {}),
            ...(options.streaming !== undefined ? { streaming: options.streaming } : {}),
            ...(resolved.sandbox !== undefined ? { sandbox: resolved.sandbox } : {}),
          },
          resolved.sandboxClient,
        ),
      inject: [
        GENUI_OPTIONS,
        GENUI_CATALOG,
        GENUI_RESOLVED,
        { token: GenuiCatalogResolver, optional: true },
      ],
    },
    ...resolverProviders(resolver),
    // The generated tools, registered by the agent module's discovery like any `provideAgentTool`.
    // Built from the injected catalog, so `overrideProvider(GENUI_CATALOG)` changes them too.
    provideAgentTools(
      (
        options: AgentGenuiOptions,
        catalog: Catalog,
        resolved: ResolvedGenui,
        perRequestResolver?: GenuiCatalogResolver,
      ) => genuiTools(catalog, toolOptions(options, resolved, perRequestResolver)),
      [
        GENUI_OPTIONS,
        GENUI_CATALOG,
        GENUI_RESOLVED,
        { token: GenuiCatalogResolver, optional: true },
      ],
    ),
  ];
}

const EXPORTS = [GENUI_CATALOG, GENUI_OPTIONS, AGENT_GENUI];

/**
 * Generative UI for the agent: registers the tools that let the model push catalog components
 * (one `ui__render` tree tool, or `ui__show_<component>` per component, and/or the generic
 * `ui__show`), and makes the catalog
 * injectable. Global, like `AgentModule`; import it once, next to it.
 *
 * ```ts
 * AgentGenuiModule.forRoot({ catalog, mode: 'tree', terminal: true })
 * ```
 */
@Module({})
export class AgentGenuiModule {
  static forRoot(options: AgentGenuiModuleOptions = {}): DynamicModule {
    const { resolver, ...rest } = options;
    return {
      module: AgentGenuiModule,
      global: true,
      providers: [{ provide: GENUI_OPTIONS, useValue: rest }, ...coreProviders(resolver)],
      exports: resolver === undefined ? EXPORTS : [...EXPORTS, GenuiCatalogResolver],
    };
  }

  static forRootAsync(options: AgentGenuiModuleAsyncOptions): DynamicModule {
    return {
      module: AgentGenuiModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        { provide: GENUI_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        ...coreProviders(options.resolver),
      ],
      exports: options.resolver === undefined ? EXPORTS : [...EXPORTS, GenuiCatalogResolver],
    };
  }
}
