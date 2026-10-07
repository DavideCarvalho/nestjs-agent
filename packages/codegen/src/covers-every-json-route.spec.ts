import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nestjsAgentCodegen } from './index.js';

/**
 * This list is hand-written against controllers this package cannot import, so the failure mode is
 * silent: an endpoint ships, every host's generated client simply does not have it, and nothing
 * anywhere says so. That is how `GET /agent/skills`, `GET /agent/memories`, `DELETE
 * /agent/memories/:id`, `POST /agent/tool-call/answer`, `POST /agent/tool-call/skip` and `GET
 * /agent/attachments` were all absent while their siblings were present.
 *
 * So the controllers are read off disk rather than imported: a dependency from a build-tool package
 * onto the Nest runtime would be the wrong direction, and nothing about a route's PATH needs Nest to
 * be running to be read.
 */
const SOURCES = fileURLToPath(new URL('../../nestjs/src', import.meta.url));

/**
 * Routes deliberately not in the generated client, each for a reason codegen cannot express.
 * Adding a route here is a decision; leaving one out of both lists is the bug this spec catches.
 */
const NOT_MODELLED = new Map([
  ['POST /agent/chat', 'streams SSE — use `useAgentChat` from @dudousxd/nestjs-agent-react'],
  ['GET /agent/chat/:runId/stream', 'streams SSE — same'],
  ['POST /agent/attachments', 'multipart upload; codegen models JSON bodies'],
  [
    'POST /agent/attachments/uploads',
    'opt-in `AgentMediaAttachmentsModule`; the tus flow is driven by the React uploader',
  ],
  ['POST /agent/attachments/uploads/:mediaId/complete', 'same'],
  ['DELETE /agent/attachments/uploads/:mediaId', 'same'],
  [
    'POST /agent/<path>',
    'the opt-in AG-UI adapter (`agUiAdapter({ path })`) — streams AG-UI events',
  ],
]);

const METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

/** Every non-spec source file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * A decorator's path argument: a string literal as written, or `<name>` for an identifier (a path
 * the host configures, e.g. an adapter's `path`). No argument → `''`.
 */
const PATH_ARG = "(?:'([^']*)'|([A-Za-z_$][\\w$]*))?";

/**
 * Every `METHOD /agent/...` the library's controllers declare, read from their source — wherever a
 * controller sits (`controller/`, `proposals/`, `media/`, an adapter), not only `controller/`.
 */
function declaredRoutes(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SOURCES)) {
    const source = readFileSync(file, 'utf8');
    const controller = new RegExp(`@Controller\\(${PATH_ARG}\\)`).exec(source);
    if (controller === null) continue;
    const base = controller[1] ?? (controller[2] !== undefined ? `<${controller[2]}>` : '');
    for (const match of source.matchAll(
      new RegExp(`@(${METHODS.join('|')})\\(${PATH_ARG}\\)`, 'g'),
    )) {
      const [, method, literal, identifier] = match;
      if (method === undefined) continue;
      const path = literal ?? (identifier !== undefined ? `<${identifier}>` : '');
      const segments = [base, path].filter((segment) => segment.length > 0);
      found.push(`${method.toUpperCase()} ${['/agent', ...segments].join('/')}`);
    }
  }
  return found.sort();
}

describe('the injected routes cover what the library serves', () => {
  it('reads the controllers it is checking against', () => {
    // Guards the parsing itself: a regex that silently matched nothing would make every assertion
    // below pass while checking nothing at all.
    const declared = declaredRoutes();
    expect(declared.length).toBeGreaterThan(15);
    expect(declared).toContain('GET /agent/threads');
    expect(declared).toContain('POST /agent/chat');
    // Controllers outside `controller/` too.
    expect(declared).toContain('GET /agent/threads/:threadId/action-proposals');
    expect(declared).toContain('POST /agent/attachments/uploads');
  });

  it('leaves no endpoint out of both the client and the not-modelled list', () => {
    const injected = new Set(
      nestjsAgentCodegen()
        .transformRoutes([])
        .map((route) => `${route.method} ${route.path}`),
    );
    const missing = declaredRoutes().filter(
      (route) => !injected.has(route) && !NOT_MODELLED.has(route),
    );
    expect(missing).toEqual([]);
  });

  it('injects nothing the controllers do not serve', () => {
    const declared = new Set(declaredRoutes());
    const phantom = nestjsAgentCodegen()
      .transformRoutes([])
      .map((route) => `${route.method} ${route.path}`)
      .filter((route) => !declared.has(route));
    expect(phantom).toEqual([]);
  });
});
