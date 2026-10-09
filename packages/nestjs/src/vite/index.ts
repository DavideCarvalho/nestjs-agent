/**
 * `@dudousxd/nestjs-agent/vite` — `genuiSandboxKit()`, the Vite plugin that puts the app's design
 * system (its components, its theme, Tailwind) inside the sandbox:
 *
 * ```ts
 * // vite.config.ts (the SPA that talks to the agent)
 * import { genuiSandboxKit } from '@dudousxd/nestjs-agent/vite'
 * export default defineConfig({ plugins: [react(), genuiSandboxKit({ include: 'src/components/ui/*.tsx' })] })
 * ```
 *
 * Then `AgentGenuiModule.forRoot({ sandbox: { kit: true, tailwind: true } })` finds the bundle and
 * the docs: the descriptor the dev server writes (`.genui/sandbox-kit.json`) in dev, the Vite
 * manifest in production (see `AgentGenuiOptions.sandboxKit`).
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
 * The sandbox kit plugin. `entry` (a module exporting the kit) or `include` (a glob of component
 * files); neither → the first `components/ui` folder (`src/components/ui`…). See
 * {@link GenuiSandboxKitOptions}.
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
