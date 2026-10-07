import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import type { Plugin } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/** Resolve workspace packages to their TS source so cross-package tests never hit a stale dist/. */
export const alias: Record<string, string> = {
  // Before the bare package name: an alias key also matches its own subpaths, first entry wins.
  '@dudousxd/nestjs-agent-core/guardrails': fileURLToPath(
    new URL('./packages/core/src/guardrails/index.ts', import.meta.url),
  ),
  '@dudousxd/nestjs-agent-core/genui/builtins': fileURLToPath(
    new URL('./packages/core/src/genui/builtins.ts', import.meta.url),
  ),
  '@dudousxd/nestjs-agent-core/ag-ui': fileURLToPath(
    new URL('./packages/core/src/ag-ui/index.ts', import.meta.url),
  ),
  '@dudousxd/nestjs-agent-core/genui': fileURLToPath(
    new URL('./packages/core/src/genui/index.ts', import.meta.url),
  ),
  '@dudousxd/nestjs-agent-core': pkg('core'),
  '@dudousxd/nestjs-agent-testing': pkg('testing'),
  '@dudousxd/nestjs-agent-store-mikro-orm': pkg('store-mikro-orm'),
  '@dudousxd/nestjs-agent-store-drizzle': pkg('store-drizzle'),
  '@dudousxd/nestjs-agent-transport-redis': pkg('transport-redis'),
  '@dudousxd/nestjs-agent-data': pkg('data'),
  '@dudousxd/nestjs-agent-authz': pkg('authz'),
  '@dudousxd/nestjs-agent-telescope': pkg('telescope'),
  '@dudousxd/nestjs-agent-diagnostics': pkg('diagnostics'),
  '@dudousxd/nestjs-agent-client': pkg('client'),
  '@dudousxd/nestjs-agent-codegen': pkg('codegen'),
  '@dudousxd/nestjs-agent-mcp-server': pkg('mcp-server'),
  '@dudousxd/nestjs-agent-mcp': pkg('mcp'),
  '@dudousxd/nestjs-agent-opencode': pkg('opencode'),
  '@dudousxd/nestjs-agent-channels': pkg('channels'),
  '@dudousxd/nestjs-agent-react/genui/json-render': fileURLToPath(
    new URL('./packages/react/src/genui/json-render.tsx', import.meta.url),
  ),
  '@dudousxd/nestjs-agent-react/genui': fileURLToPath(
    new URL('./packages/react/src/genui/index.ts', import.meta.url),
  ),
  '@dudousxd/nestjs-agent-react/media': fileURLToPath(
    new URL('./packages/react/src/media/index.ts', import.meta.url),
  ),
  '@dudousxd/nestjs-agent-react': pkg('react'),
  '@dudousxd/nestjs-agent/genui': fileURLToPath(
    new URL('./packages/nestjs/src/genui/index.ts', import.meta.url),
  ),
  '@dudousxd/nestjs-agent/media': fileURLToPath(
    new URL('./packages/nestjs/src/media/index.ts', import.meta.url),
  ),
  '@dudousxd/nestjs-agent': pkg('nestjs'),
  // The registry ships shadcn-flavoured source, which reaches `cn` through the alias every shadcn
  // project already has. Nothing under packages/ uses an `@/` specifier, so this resolves only
  // registry files.
  '@/lib/utils': fileURLToPath(new URL('./registry/src/lib/utils.ts', import.meta.url)),
};

/** SWC transform so NestJS decorator metadata works under Vitest (esbuild can't emit it). */
export const plugins: Plugin[] = [
  swc.vite({
    jsc: {
      target: 'es2022',
      parser: { syntax: 'typescript', tsx: true, decorators: true },
      transform: {
        legacyDecorator: true,
        decoratorMetadata: true,
        // React's automatic JSX runtime (matches the dashboard's `jsx: react-jsx`). Without it swc
        // emits `React.createElement` and every .tsx render spec dies on an undefined `React`.
        react: { runtime: 'automatic' },
      },
    },
  }),
];

export const testBase = {
  globals: true,
  environment: 'node' as const,
  setupFiles: ['./vitest.setup.ts'],
};
