/**
 * `@dudousxd/nestjs-agent-core/genui/kit` — the Node half of the sandbox kit: the files a kit is made
 * of, the docs generated from their types, the styles compiled, the bundle, the Vite plugin factory,
 * and finding all of it at runtime. The Vite plugin itself is `genuiSandboxKit()` from
 * `@dudousxd/nestjs-agent/vite`.
 */
export {
  type BuildSandboxKitOptions,
  buildSandboxKitBundle,
  kitDocsFromBundle,
  type SandboxKitBundle,
} from './bundle.js';
export {
  type ResolvedSandboxServer,
  resolveSandboxServer,
  type SandboxKitDiscovery,
  type SandboxKitDiscoveryOptions,
  sandboxKitDiscovery,
} from './discover.js';
export { type GenerateSandboxKitDocsOptions, generateSandboxKitDocs } from './docs.js';
export {
  assertNoLegacyKitOptions,
  DEFAULT_KIT_DIRS,
  globFiles,
  globToRegExp,
  resolveSandboxKitFiles,
  resolveSandboxKitWrapper,
  type SandboxKitFiles,
  type SandboxKitSourceOptions,
} from './files.js';
export {
  createGenuiSandboxKitPlugin,
  type GenuiSandboxKitApi,
  type GenuiSandboxKitDefaults,
  type GenuiSandboxKitOptions,
  type GenuiSandboxKitPlugin,
  SANDBOX_KIT_DEV_PREFIX,
  SANDBOX_KIT_MANIFEST_KEYS,
  SANDBOX_KIT_UPDATE_EVENT,
} from './plugin.js';
export {
  type BuildSandboxKitStylesOptions,
  buildSandboxKitStyles,
  collectStyleSources,
  discoverStyleEntries,
  readStylesGuide,
  resolveStyleEntries,
  resolveStyleImport,
  type SandboxKitStyles,
  STYLE_EXTENSIONS,
  type StyleSource,
} from './styles.js';
export { type WriteSandboxKitDocsOptions, writeSandboxKitDocs } from './write.js';
