import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import type { Plugin } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/** Resolve workspace packages to their TS source so cross-package tests never hit a stale dist/. */
export const alias: Record<string, string> = {
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
  '@dudousxd/nestjs-agent-react': pkg('react'),
  '@dudousxd/nestjs-agent': pkg('nestjs'),
};

/** SWC transform so NestJS decorator metadata works under Vitest (esbuild can't emit it). */
export const plugins: Plugin[] = [
  swc.vite({
    jsc: {
      target: 'es2022',
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  }),
];

export const testBase = {
  globals: true,
  environment: 'node' as const,
  setupFiles: ['./vitest.setup.ts'],
};
