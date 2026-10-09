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
  type GenuiStreaming,
  toolNameFor,
  toSnakeCase,
} from './catalog.js';
export {
  type GenuiPartialElement,
  type PartialTreeOptions,
  partialTree,
  treeNodeId,
} from './progressive.js';
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
  type TreeSchemaMode,
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

export {
  jsonByteLength,
  type ReadUiActionOptions,
  readUiAction,
  sandboxAction,
  UI_ACTION_MAX_BYTES,
  type UiAction,
  type UiActionSource,
  uiActionText,
  validateUiActionContext,
} from './actions.js';
export {
  assertSandboxPolicy,
  buildSandboxDocument,
  type DefineSandboxOptions,
  defineSandbox,
  previewHtml,
  SANDBOX_COMPONENT,
  SANDBOX_DEFAULTS,
  SANDBOX_FIELD_ORDER,
  SANDBOX_IFRAME_FLAGS,
  SANDBOX_MESSAGE,
  Sandbox,
  type SandboxDefinition,
  type SandboxDocumentOptions,
  type SandboxPolicy,
  type SandboxProps,
  sandboxCsp,
  sandboxPartialProps,
  sandboxPolicyOf,
} from './sandbox.js';
