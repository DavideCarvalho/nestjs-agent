/**
 * `@dudousxd/nestjs-agent-core/genui/kit` — the Node half of the sandbox kit: the files a kit is made
 * of, the docs generated from their types, the bundle, the Vite plugin factory, and finding all of
 * it at runtime. The Vite plugin itself is `genuiSandboxKit()` from `@dudousxd/nestjs-agent/vite`.
 */
export {
  type BuildSandboxKitOptions,
  buildSandboxKitBundle,
  type SandboxKitBundle,
} from './bundle.js';
export {
  type ResolvedSandboxServer,
  resolveSandboxServer,
  type SandboxKitDiscovery,
  type SandboxKitDiscoveryOptions,
  sandboxKitDiscovery,
} from './discover.js';
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
export { type GenerateSandboxKitDocsOptions, generateSandboxKitDocs } from './docs.js';
export {
  DEFAULT_KIT_DIRS,
  globFiles,
  globToRegExp,
  resolveSandboxKitFiles,
  type SandboxKitFiles,
  type SandboxKitSourceOptions,
} from './files.js';
export { writeSandboxKitDocs } from './write.js';
