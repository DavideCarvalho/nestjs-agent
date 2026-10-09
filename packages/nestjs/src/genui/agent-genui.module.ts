import type { ToolPresentation } from '@dudousxd/nestjs-agent-core';
import type {
  Catalog,
  GenuiCatalogScope,
  GenuiStreaming,
  GenuiToolsOptions,
  TreeLimits,
  TreeSchemaMode,
} from '@dudousxd/nestjs-agent-core/genui';
import {
  type DefineSandboxOptions,
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

/** The app's genui catalog — `@InjectGenuiCatalog()` it anywhere; `overrideProvider` it in tests. */
export const GENUI_CATALOG = Symbol.for('@dudousxd/nestjs-agent:genui-catalog');

/** The resolved {@link AgentGenuiOptions} (without the resolver). */
export const GENUI_OPTIONS = Symbol.for('@dudousxd/nestjs-agent:genui-options');

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
   */
  sandbox?: boolean | DefineSandboxOptions;
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

function toolOptions(
  options: AgentGenuiOptions,
  resolver: GenuiCatalogResolver | undefined,
): GenuiToolsOptions {
  const { catalog: _catalog, sandbox: _sandbox, ...rest } = options;
  return {
    ...rest,
    ...(resolver !== undefined
      ? { resolveCatalog: (scope: GenuiCatalogScope) => resolver.resolve(scope) }
      : {}),
  };
}

/** The configured catalog, with the sandbox component added when `sandbox` asks for it. */
function withSandbox(options: AgentGenuiOptions): Catalog {
  const base = options.catalog ?? defineCatalog([]);
  const { sandbox } = options;
  return sandbox === undefined || sandbox === false
    ? base
    : base.extend([defineSandbox(sandbox === true ? {} : sandbox)]);
}

function coreProviders(resolver: ResolverOption | undefined): Provider[] {
  return [
    {
      provide: GENUI_CATALOG,
      useFactory: (options: AgentGenuiOptions) => withSandbox(options),
      inject: [GENUI_OPTIONS],
    },
    ...resolverProviders(resolver),
    // The generated tools, registered by the agent module's discovery like any `provideAgentTool`.
    // Built from the injected catalog, so `overrideProvider(GENUI_CATALOG)` changes them too.
    provideAgentTools(
      (options: AgentGenuiOptions, catalog: Catalog, perRequest?: GenuiCatalogResolver) =>
        genuiTools(catalog, toolOptions(options, perRequest)),
      [GENUI_OPTIONS, GENUI_CATALOG, { token: GenuiCatalogResolver, optional: true }],
    ),
  ];
}

const EXPORTS = [GENUI_CATALOG, GENUI_OPTIONS];

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
