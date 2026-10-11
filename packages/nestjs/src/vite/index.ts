/**
 * `@dudousxd/nestjs-agent/vite` — `genuiSandboxKit()`, the Vite plugin that puts the app's design
 * system (its styles, its components, its providers) inside the sandbox, whatever the stack:
 *
 * ```ts
 * // vite.config.ts (the SPA that talks to the agent)
 * import { genuiSandboxKit } from '@dudousxd/nestjs-agent/vite'
 * export default defineConfig({
 *   plugins: [react(), genuiSandboxKit({ styles: 'src/index.css', components: 'src/components/ui' })],
 * })
 * ```
 *
 * Then `AgentGenuiModule.forRoot({ sandbox: { kit: true } })` finds what it built: the descriptor
 * the dev server writes (`.genui/sandbox-kit.json`) in dev, the Vite manifest in production (see
 * `AgentGenuiOptions.sandboxKit`).
 */
import {
  type GenuiSandboxKitApi,
  type GenuiSandboxKitOptions,
  type GenuiSandboxKitPlugin,
  SANDBOX_KIT_DEV_PREFIX,
  SANDBOX_KIT_MANIFEST_KEYS,
  SANDBOX_KIT_UPDATE_EVENT,
  createGenuiSandboxKitPlugin,
} from '@dudousxd/nestjs-agent-core/genui/kit';

/**
 * Where the dev descriptor is written, relative to the Vite root — and where the server reads it,
 * relative to its working directory (run both from the project root, or point
 * `sandboxKit.descriptor` at it). Add `.genui/` to `.gitignore`.
 */
export const NEST_SANDBOX_KIT_DESCRIPTOR = '.genui/sandbox-kit.json';

/**
 * The sandbox kit plugin: `styles` (the app's style entries — default, the stylesheets among its
 * Vite entrypoints or `index.html`), `components` (modules or globs exporting React components —
 * default, the first `components/ui` folder), `wrapper` (a module whose default export wraps the
 * model's App). See {@link GenuiSandboxKitOptions}.
 */
export function genuiSandboxKit(options: GenuiSandboxKitOptions = {}): GenuiSandboxKitPlugin {
  return createGenuiSandboxKitPlugin(options, {
    descriptor: NEST_SANDBOX_KIT_DESCRIPTOR,
    rendererImport: /@dudousxd\/nestjs-agent-react/,
  });
}

export {
  type GenuiSandboxKitApi,
  type GenuiSandboxKitOptions,
  type GenuiSandboxKitPlugin,
  SANDBOX_KIT_DEV_PREFIX,
  SANDBOX_KIT_MANIFEST_KEYS,
  SANDBOX_KIT_UPDATE_EVENT,
};
