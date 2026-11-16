import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The SPA is served under /ai-gateway; the UI controller rewrites this base when mounted elsewhere.
  base: '/ai-gateway/',
  // CSS-referenced assets (the kit's bundled fonts) load relative to the stylesheet: the controller
  // rewrites the `/ai-gateway/` base in index.html only, so an absolute `/ai-gateway/assets/…` font
  // URL inside the CSS would 404 once the console is mounted anywhere else.
  experimental: {
    renderBuiltUrl: (_file, { hostType }) => (hostType === 'css' ? { relative: true } : undefined),
  },
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
    rollupOptions: {
      // `index.html` is the production SPA entry; `preview.html` is an additive, standalone
      // mock-data entry used only for visual verification of the console with no backend. Both are
      // listed explicitly so `vite build` keeps emitting the SPA while also compiling the preview.
      input: {
        index: resolve(__dirname, 'index.html'),
        preview: resolve(__dirname, 'preview.html'),
      },
      output: {
        // TanStack Charts (with its d3 scales/shapes) and Base UI are the heaviest dependencies in
        // the bundle. Both get their own chunk so the console's own code — which changes every
        // release — does not invalidate them in every browser cache on every deploy.
        //
        // Both are listed as the SUBPATHS this console imports (TanStack Charts: the ones
        // `src/aviary-kit/charts/` imports). Base UI is listed as the SUBPATHS this console imports rather than the package root: the
        // root barrel reaches every primitive in the library, so naming it here would pull the
        // accordion, the menubar and thirty others into the chunk that tree-shaking had correctly
        // left out. Add a line when a new primitive is vendored under `src/app/ui/` or `src/aviary-kit/ui/`.
        manualChunks: {
          charts: [
            '@tanstack/charts/area',
            '@tanstack/charts/bar',
            '@tanstack/charts/group',
            '@tanstack/charts/line',
            '@tanstack/charts/mark/decorative',
            '@tanstack/charts/polar',
            '@tanstack/charts/react',
            '@tanstack/charts/scales/band',
            '@tanstack/charts/scales/linear',
            '@tanstack/charts/scales/point',
            '@tanstack/charts/scene',
            '@tanstack/charts/stack',
            '@tanstack/charts/tooltip',
            '@tanstack/charts/tooltip/portal',
          ],
          'base-ui': [
            '@base-ui/react/avatar',
            '@base-ui/react/button',
            '@base-ui/react/collapsible',
            '@base-ui/react/dialog',
            '@base-ui/react/drawer',
            '@base-ui/react/input',
            '@base-ui/react/menu',
            '@base-ui/react/merge-props',
            '@base-ui/react/popover',
            '@base-ui/react/scroll-area',
            '@base-ui/react/select',
            '@base-ui/react/tabs',
            '@base-ui/react/separator',
            '@base-ui/react/tooltip',
            '@base-ui/react/use-render',
          ],
        },
      },
    },
  },
});
