import { defineConfig } from 'tsup';

// Libraries kept OUT of the bundle. `react`/`ai` are runtime peers; the
// markdown subpath's renderer libs (streamdown + plugins, katex, the
// remark/rehype/prism stack) are OPTIONAL peers — only consumers of
// `@dudousxd/nestjs-agent-react/markdown` install them, so they must
// never be inlined into either entry.
const external = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@ai-sdk/react',
  'ai',
  'streamdown',
  'streamdown/styles.css',
  '@streamdown/code',
  '@streamdown/math',
  '@streamdown/mermaid',
  'katex',
  'katex/dist/katex.min.css',
  'react-markdown',
  'remark-gfm',
  'remark-math',
  'rehype-katex',
  'rehype-sanitize',
  'prism-react-renderer',
  'unist-util-visit',
  '@json-render/react',
  '@json-render/core',
  '@dudousxd/nestjs-media-client',
];

// JSX compiles to the automatic runtime (`react/jsx-runtime`), never to `React.createElement`: a
// module built the classic way needs a global `React`, which a consumer's app does not have.
// Said here as well as in tsconfig.json (`jsx: react-jsx`) so neither file alone can undo it;
// `scripts/verify-dist.mjs` and the repo's `check-dist-react` fail the build if it regresses.
const jsx = {
  esbuildOptions(options: { jsx?: string; jsxImportSource?: string }) {
    options.jsx = 'automatic';
    options.jsxImportSource = 'react';
  },
};

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      markdown: 'src/markdown/index.ts',
      genui: 'src/genui/index.ts',
      'genui-json-render': 'src/genui/json-render.tsx',
      media: 'src/media/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    external,
    ...jsx,
  },
  {
    entry: {
      index: 'src/index.ts',
      markdown: 'src/markdown/index.ts',
      genui: 'src/genui/index.ts',
      'genui-json-render': 'src/genui/json-render.tsx',
      media: 'src/media/index.ts',
    },
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    external,
    ...jsx,
  },
]);
