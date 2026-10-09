/**
 * The sandbox kit in a Nest app. No Vite runs in the Nest process, so the kit is found in files:
 * the descriptor `genuiSandboxKit()` (`@dudousxd/nestjs-agent/vite`) writes while the dev server
 * runs, and in production the Vite manifest the build wrote (`genui-sandbox-kit.json` and the assets
 * it names). Node-only: loaded by {@link AgentGenuiModule} only when a sandbox is configured.
 */
import { resolve } from 'node:path';
import {
  type SandboxKitDiscovery,
  sandboxKitDiscovery,
} from '@dudousxd/nestjs-agent-core/genui/kit';
import { NEST_SANDBOX_KIT_DESCRIPTOR } from '../vite/index.js';
import type { AgentGenuiSandboxKitOptions } from './agent-genui.module.js';

/** Where the production Vite manifest is looked for by default, and the directory it is relative to. */
export const NEST_SANDBOX_KIT_MANIFEST = Object.freeze({
  file: 'public/.vite/manifest.json',
  outDir: 'public',
});

/** Find the kit for `AgentGenuiModule.forRoot({ sandbox: { kit: true } })`. */
export function nestSandboxKitDiscovery(
  options: AgentGenuiSandboxKitOptions = {},
): SandboxKitDiscovery {
  const manifest = options.manifest ?? NEST_SANDBOX_KIT_MANIFEST;
  return sandboxKitDiscovery({
    root: resolve(options.root ?? process.cwd()),
    descriptor: options.descriptor ?? NEST_SANDBOX_KIT_DESCRIPTOR,
    ...(manifest !== false ? { manifest: { file: manifest.file, outDir: manifest.outDir } } : {}),
    ...(options.kitUrl !== undefined ? { kitUrl: options.kitUrl } : {}),
    ...(options.production !== undefined ? { production: options.production } : {}),
  });
}
