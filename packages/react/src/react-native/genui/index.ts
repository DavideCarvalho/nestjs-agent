/**
 * Generative UI for React Native: the sandbox renderer (`createNativeSandboxRenderer`, drawn in a
 * hardened `react-native-webview`), and the React Native-safe part of `@dudousxd/nestjs-agent-react/genui`
 * — the provider, `GenerativeUI`, the action context and the types. Import these from here in an app:
 * the web entry also carries the iframe renderer, whose module touches `window` as it loads.
 *
 * Needs `react-native` and `react-native-webview` (optional peers of the package, used by this
 * entry only).
 */
export {
  readUiActionText,
  SANDBOX_COMPONENT,
  SANDBOX_DEFAULTS,
  type SandboxPolicy,
  type SandboxProps,
  type UiAction,
  type UiActionMessage,
  uiActionSummary,
} from '@dudousxd/nestjs-agent-core/genui';
export {
  GenerativeUI,
  type GenerativeUIFallback,
  type GenerativeUIProps,
  GenerativeUIScope,
  type GenerativeUIScopeProps,
  GenuiNodeScope,
  type GenuiProviderProps,
  type GenuiProviderValue,
  GenuiTree,
  useGenerativeUI,
  useGenuiNode,
  useGenuiProvider,
} from '../../genui/generative-ui.js';
export type { SandboxRefusal } from '../../genui/sandbox.js';
export {
  GENUI_TREE_COMPONENT,
  type GenerativeUIElement,
  type GenerativeUIItem,
  type GenerativeUIOptions,
  type GenerativeUIProblem,
  type GenerativeUIState,
  type GenuiCatalogLike,
  type GenuiIssueLike,
  type GenuiNodeState,
  type GenuiPlaceholder,
  type GenuiRegistry,
  type GenuiRenderer,
  type ResolveComponent,
} from '../../genui/types.js';
export { toGenerativeUIItem } from '../../genui/use-generative-ui.js';
export {
  GenuiActionProvider,
  GenuiProvider,
  nativeGenuiFallback,
  useGenuiAction,
} from './provider.js';
export {
  createNativeSandboxRenderer,
  type GenuiActionHandler,
  NATIVE_SANDBOX_WEBVIEW_PROPS,
  type NativeSandboxRendererOptions,
  NativeSandboxView,
} from './sandbox.js';
export type {
  FetchLike,
  NativeSandboxConfig,
  NativeSandboxConfigSource,
} from './sandbox-assets.js';
export {
  isInlineDocumentUrl,
  type NativeSandboxTheme,
  nativeThemeCss,
  type UiActionSchema,
} from './sandbox-host.js';
