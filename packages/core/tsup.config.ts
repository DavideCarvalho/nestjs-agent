import { defineConfig } from 'tsup';

// `ag-ui` is its own entry so the AG-UI producer (shared with `@adonis-agora/agent`) stays out of
// the main bundle of a host that does not serve it.
// `guardrails` is its own entry so `@dudousxd/nestjs-agent-core/guardrails` can be imported by a
// process that never runs the agent loop (a gateway proxying raw provider traffic). `genui` and
// `genui/builtins` are their own entries so a BROWSER can import the catalog: nothing they bundle
// reaches the loop or a server-only dependency (src/genui/isomorphic.spec.ts holds that line).
const entry = {
  index: 'src/index.ts',
  'guardrails/index': 'src/guardrails/index.ts',
  'genui/index': 'src/genui/index.ts',
  'genui/builtins': 'src/genui/builtins.ts',
  'ag-ui/index': 'src/ag-ui/index.ts',
  'a2ui/index': 'src/a2ui/index.ts',
};

export default defineConfig([
  {
    entry,
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
  {
    entry,
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
]);
