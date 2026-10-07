/**
 * `@dudousxd/nestjs-agent-core/genui` — the generative-UI catalog: component definitions (Standard
 * Schema or JSON Schema props), validation, model-facing catalog text, plain-text fallbacks and the
 * tools that push `ui` frames. Isomorphic: this entry imports nothing server-only, so the same
 * catalog file serves the NestJS app and the browser. Builtin definitions live at
 * `@dudousxd/nestjs-agent-core/genui/builtins`.
 */
export {
  type Catalog,
  type CatalogOptions,
  COMPONENT_NAME,
  type ComponentDefinition,
  defineCatalog,
  defineComponent,
  flatComponents,
  toolNameFor,
  toSnakeCase,
} from './catalog.js';
export {
  type AjvLike,
  ajvValidator,
  builtinJsonSchemaValidator,
  formatIssues,
  type GenuiIssue,
  type GenuiValidation,
  isStandardSchema,
  type JsonSchema,
  type JsonSchemaValidator,
  type PropsSchema,
  toJsonSchema,
  validateProps,
  validatePropsSync,
} from './schema.js';
export {
  type CatalogTextOptions,
  catalogToModelText,
  componentToText,
  fillTemplate,
  getPath,
  summarizeSchema,
  treeToText,
} from './text.js';
export {
  GENUI_SHOW_TOOL,
  type GenuiCatalogScope,
  type GenuiTool,
  type GenuiToolOutput,
  type GenuiToolsOptions,
  genuiTools,
  jsonStandardSchema,
  type ResolveGenuiCatalog,
  showToolJsonSchema,
} from './tools.js';
export {
  type FlatSpec,
  GENUI_TREE_COMPONENT,
  type GenuiElement,
  type GenuiTreeProps,
  type TreeLimits,
  treeJsonSchema,
  treeToFlatSpec,
  validateTree,
} from './tree.js';

export {
  type UiCapabilities,
  type PreparedUiEmission,
  negotiateCatalog,
  prepareUiEmission,
  validateUiCapabilities,
} from './capabilities.js';

export {
  type ComponentPresentation,
  type ComponentFactory,
  type ComponentRenderer,
  type ComponentManifest,
  type ComponentRegistry,
  type TableCell,
  type TableProps,
  type ChartProps,
  createComponent,
  createComponentRegistry,
  snapshotComponentPresentation,
  table,
  chart,
} from './registry.js';
export { validatePresentationBatch } from './registry.js';
