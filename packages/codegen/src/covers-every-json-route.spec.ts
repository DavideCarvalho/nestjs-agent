import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
const CONTROLLERS = join(import.meta.dirname, '../../nestjs/src/controller');

/**
 * Routes deliberately not in the generated client, each for a reason codegen cannot express.
 * Adding a route here is a decision; leaving one out of both lists is the bug this spec catches.
 */
const NOT_MODELLED = new Map([
  ['POST /agent/chat', 'streams SSE — use `useAgentChat` from @dudousxd/nestjs-agent-react'],
  ['GET /agent/chat/:runId/stream', 'streams SSE — same'],
  ['POST /agent/attachments', 'multipart upload; codegen models JSON bodies'],
]);

const METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

/** Every `METHOD /agent/...` the library's controllers declare, read from their source. */
function declaredRoutes(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(CONTROLLERS).filter(
    (name) => name.endsWith('.controller.ts') && !name.endsWith('.spec.ts'),
  )) {
    const source = readFileSync(join(CONTROLLERS, file), 'utf8');
    const base = /@Controller\((?:'([^']*)')?\)/.exec(source)?.[1] ?? '';
    for (const match of source.matchAll(
      new RegExp(`@(${METHODS.join('|')})\\((?:'([^']*)')?\\)`, 'g'),
    )) {
      const [, method, path] = match;
      if (method === undefined) continue;
      const segments = [base, path ?? ''].filter((segment) => segment.length > 0);
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
