/**
 * `@dudousxd/nestjs-agent/genui` — generative UI for NestJS: {@link AgentGenuiModule} registers the
 * tools that push catalog components, `GENUI_CATALOG` / `@InjectGenuiCatalog()` expose the catalog,
 * and {@link GenuiCatalogResolver} serves per-request (per-tenant) catalogs. The catalog itself —
 * `defineComponent`, `defineCatalog`, validation, text fallbacks — is re-exported from
 * `@dudousxd/nestjs-agent-core/genui`, the isomorphic entry a browser imports too.
 */
export {
  AgentGenuiModule,
  type AgentGenuiModuleAsyncOptions,
  type AgentGenuiModuleOptions,
  type AgentGenuiOptions,
  GENUI_CATALOG,
  GENUI_OPTIONS,
  GenuiCatalogResolver,
  InjectGenuiCatalog,
} from './agent-genui.module.js';
export * from '@dudousxd/nestjs-agent-core/genui';
