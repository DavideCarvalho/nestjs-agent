import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  StreamableFile,
} from '@nestjs/common';
import { DASHBOARD_API_PATH, DASHBOARD_BASE_PATH } from './tokens.js';

/** The base the SPA bundle was built with (Vite `base`); rewritten to the configured base at serve time. */
const BUILD_BASE = '/ai-gateway';

/** dist/server/agent-ui.controller.js -> ../spa (the Vite build output). */
function spaDir(): string {
  return fileURLToPath(new URL('../spa', import.meta.url));
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/**
 * Serves the bundled AI-gateway console SPA at the configured base (+ hashed assets at
 * `<base>/assets`). The path comes from `RouterModule` (set by
 * {@link AgentDashboardModule.forRoot}({ basePath })), so the controller routes are relative.
 */
@Controller()
export class AgentUiController {
  private readonly dir = spaDir();

  constructor(
    @Inject(DASHBOARD_BASE_PATH) private readonly basePath: string,
    @Inject(DASHBOARD_API_PATH) private readonly apiBasePath: string,
  ) {}

  // index.html references hash-named bundles, so it MUST NOT be cached (stale bundle = the classic
  // "stuck loading after a deploy"). The hashed assets below are immutable.
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, must-revalidate')
  index(): string {
    const indexPath = join(this.dir, 'index.html');
    if (!existsSync(indexPath)) {
      throw new NotFoundException('Dashboard is not built. Run the package build.');
    }
    // The bundle was built with Vite base `/ai-gateway/`; rewrite asset URLs to the configured base
    // so the SPA loads from `<base>/assets` wherever it's mounted, and tell the client its API base.
    const html = readFileSync(indexPath, 'utf8').replaceAll(
      `="${BUILD_BASE}/`,
      `="${this.basePath}/`,
    );
    // __AGENT_BASE__ = where assets load; __AGENT_API__ = where the SPA fetches the JSON API.
    const inject = `<script>window.__AGENT_BASE__='${this.basePath}';window.__AGENT_API__='${this.apiBasePath}';</script>`;
    return html.includes('</head>') ? html.replace('</head>', `${inject}</head>`) : inject + html;
  }

  @Get('assets/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  asset(@Param('file') file: string): StreamableFile {
    const safe = basename(file);
    if (safe !== file) throw new NotFoundException();
    const root = resolve(this.dir, 'assets');
    const assetPath = resolve(root, safe);
    if (!assetPath.startsWith(root + sep) || !existsSync(assetPath)) {
      throw new NotFoundException();
    }
    const type = CONTENT_TYPES[extname(safe)] ?? 'application/octet-stream';
    return new StreamableFile(readFileSync(assetPath), { type });
  }
}
