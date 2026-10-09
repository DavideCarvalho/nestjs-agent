import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NEST_SANDBOX_KIT_DESCRIPTOR,
  SANDBOX_KIT_MANIFEST_KEYS,
  SANDBOX_KIT_UPDATE_EVENT,
  genuiSandboxKit,
} from './index.js';

describe('genuiSandboxKit() — the Nest defaults', () => {
  it('writes its dev descriptor where AgentGenuiModule reads it', () => {
    expect(NEST_SANDBOX_KIT_DESCRIPTOR).toBe('.genui/sandbox-kit.json');
    expect(SANDBOX_KIT_MANIFEST_KEYS).toEqual({
      kit: 'genui-sandbox-kit.js',
      tailwind: 'genui-sandbox-tailwind.js',
      descriptor: 'genui-sandbox-kit.json',
    });
    expect(genuiSandboxKit().name).toBe('genui-sandbox-kit');
  });

  it('dev: an app module importing the React renderer gets the HMR bridge', () => {
    const plugin = genuiSandboxKit();
    (plugin.configResolved as (c: unknown) => void)({
      root: process.cwd(),
      base: '/',
      command: 'serve',
      resolve: {},
      build: {},
      logger: console,
    });
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
    const out = transform(
      "import { SandboxView } from '@dudousxd/nestjs-agent-react/genui'",
      resolve(process.cwd(), 'src/page.tsx'),
    );
    expect(out?.code).toContain(`import.meta.hot.on("${SANDBOX_KIT_UPDATE_EVENT}"`);
    expect(transform("import { x } from './other'", resolve(process.cwd(), 'src/a.tsx'))).toBe(
      null,
    );
  });
});
