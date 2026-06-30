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
];

export default defineConfig([
  {
    entry: { index: 'src/index.ts', markdown: 'src/markdown/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    external,
  },
  {
    entry: { index: 'src/index.ts', markdown: 'src/markdown/index.ts' },
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    external,
  },
]);
