/**
 * `@dudousxd/nestjs-agent-core/genui` — the generative-UI catalog: component definitions (Standard
 * Schema or JSON Schema props), validation, model-facing catalog text, plain-text fallbacks and the
 * tools that push `ui` frames. Isomorphic: this entry imports nothing server-only, so the same
 * catalog file serves the NestJS app and the browser. Builtin definitions live at
 * `@dudousxd/nestjs-agent-core/genui/builtins`; charts as images for text channels at
 * `@dudousxd/nestjs-agent-core/genui/chart-image`; the Node half of the sandbox kit (docs, bundle,
 * discovery) at `@dudousxd/nestjs-agent-core/genui/kit`.
 */
export {
  type Catalog,
  type CatalogOptions,
  COMPONENT_NAME,
  type ComponentDefinition,
  type DefineComponentExtras,
  defineCatalog,
  defineComponent,
  flatComponents,
  type GenuiStreaming,
  toolNameFor,
  toSnakeCase,
} from './catalog.js';
export {
  assertGenuiChannels,
  type ChannelComponentInput,
  type ChannelConversion,
  type ChannelNativeButton,
  type ChannelNativeImage,
  type ChannelNativeList,
  type ChannelNativeListItem,
  type ChannelNativeMessage,
  type ChannelRenderedMessage,
  type ChartImageRenderer,
  type ComponentChannels,
  canRenderOnChannel,
  channelButtonAction,
  channelCatalog,
  channelInstructions,
  DEFAULT_CHANNEL,
  type GenuiChannelBase,
  type GenuiChannelMode,
  type GenuiChannelOptions,
  type GenuiChannelRender,
  type GenuiChannels,
  isMessagingChannel,
  MESSAGING_CHANNELS,
  type ResolvedGenuiChannel,
  renderChannelMessages,
  resolveGenuiChannel,
  stampChannel,
  textToHtml,
  turnChannel,
  WEB_CHANNEL,
} from './channels.js';
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
  normalizeTreeInput,
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
  readUiActionText,
  sandboxAction,
  UI_ACTION_MAX_BYTES,
  type UiAction,
  type UiActionMessage,
  type UiActionSource,
  uiActionSummary,
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
  type SandboxKitSource,
  type SandboxPolicy,
  type SandboxProps,
  type SandboxThemeSource,
  type SandboxView,
  sandboxCsp,
  sandboxPartialProps,
  sandboxPolicyOf,
} from './sandbox.js';
export { prepareSandboxJsx, transpileJsx } from './sandbox-jsx.js';
export {
  kitDocsToModelText,
  kitJsxInstructions,
  SANDBOX_ASSET_SIZES,
  type SandboxClientConfig,
  type SandboxKitComponentDoc,
  type SandboxKitDescriptor,
  type SandboxKitDocs,
  type SandboxKitPropDoc,
  sandboxJsxRuntime,
  tailwindInstructions,
} from './sandbox-kit.js';
export {
  collectHostThemeVars,
  hostThemeCss,
  isColorValue,
  isHostDark,
  isHslChannels,
  type ThemeDocument,
  type ThemeTokens,
  tailwindThemeCss,
  themeTokens,
  themeToModelText,
  themeVarsFromCss,
  watchHostTheme,
} from './sandbox-theme.js';
