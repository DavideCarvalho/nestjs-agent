import type { RouteDescriptor } from '@dudousxd/nestjs-codegen';
import type { CodegenExtension } from '@dudousxd/nestjs-codegen/extension';

/**
 * What {@link nestjsAgentCodegen} returns. `transformRoutes` is always present, runs synchronously
 * and ignores the extension context — it only appends a fixed route list.
 */
export interface AgentCodegenExtension extends CodegenExtension {
  transformRoutes(routes: RouteDescriptor[]): RouteDescriptor[];
}

/** Options for {@link nestjsAgentCodegen}. */
export interface AgentCodegenOptions {
  /**
   * Path prefix the agent controllers are mounted under (e.g. `'/api'` → `/api/agent/...`).
   * Default `''` (mounted at the root, so routes start at `/agent`).
   */
  basePath?: string;
  /** Route-name namespace for the generated client (`api.<name>.threads.list`, …). Default `'agent'`. */
  name?: string;
}

// Wire shapes returned by the JSON endpoints (dates are ISO strings over the wire).
//
// KEEP IN SYNC with the real `MessageUsage` / `StoredMessage` / `AgentCatalogEntry` in
// `@dudousxd/nestjs-agent-core` — see `packages/core/src/types.ts`. These are hand-mirrored here
// because the agent controllers live in `node_modules`, where the codegen's static AST discovery
// can't read their return types, so a change to the core types must be reflected below by hand.
//
// The deeply nested tool-call payloads are intentionally loose (`Record<string, unknown>[]`) — the
// typed surface that matters to a frontend is the thread/message envelope; rich tool data flows
// through the React tool-part renderer.
const USAGE =
  '{ inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number; reasoningTokens?: number }';
const STORED_MESSAGE = `{ id: string; role: 'user' | 'assistant' | 'system'; content: string; agentName?: string; toolCalls?: Record<string, unknown>[]; toolResults?: Record<string, unknown>[]; followUps?: string[]; usage?: ${USAGE}; createdAt: string }`;
const THREAD_SUMMARY =
  '{ id: string; title: string; transient: boolean; ' +
  'createdAt: string; updatedAt: string; lastMessagePreview?: string }';
const THREAD_DETAIL = `${THREAD_SUMMARY.slice(0, -2)}; messages: ${STORED_MESSAGE}[]; activeStreamId?: string }`;
/** The `GET /agent/agents` catalog entry — mirrors `AgentCatalogEntry` in core/src/types.ts. */
const AGENT_CATALOG_ENTRY = '{ name: string; description: string; isDefault?: boolean }';

/** `GET /agent/skills` — mirrors `SkillCatalogEntry` in core/src/skills.ts. */
const SKILL_CATALOG_ENTRY =
  '{ name: string; description: string; scope: string; shadows?: string[] }';
const MEMORY_ORIGIN =
  "{ author: 'agent' | 'human'; threadId?: string; runId?: string; actorRef?: string }";
const OVERRIDDEN_MEMORY = "{ scope: string; text: string; author: 'agent' | 'human' }";
/** `GET /agent/memories` — mirrors `MemoryDigestEntry` in core/src/memory.ts. */
const MEMORY_ENTRY = `{ id: string; key: string; text: string; scope: string; origin: ${MEMORY_ORIGIN}; updatedAt: string; pinned?: boolean; overrides?: ${OVERRIDDEN_MEMORY}[] }`;
/** `GET /agent/attachments` — mirrors `StagedAttachment` in core/src/spi/attachment-staging.ts. */
const STAGED_ATTACHMENT =
  '{ mediaId: string; name: string; contentType: string; sizeBytes: number; createdAt: string }';

function route(
  method: string,
  path: string,
  name: string,
  contract: { query: string | null; body: string | null; response: string },
  params: Array<{ name: string; source: 'path' | 'query' | 'body' | 'header' }> = [],
): RouteDescriptor {
  return { method, path, name, params, contract: { contractSource: contract } };
}

function agentRoutes(base: string, ns: string): RouteDescriptor[] {
  const root = `${base}/agent`;
  return [
    route('GET', `${root}/agents`, `${ns}.agents.list`, {
      query: null,
      body: null,
      response: `${AGENT_CATALOG_ENTRY}[]`,
    }),
    route('GET', `${root}/threads`, `${ns}.threads.list`, {
      query: null,
      body: null,
      response: `${THREAD_SUMMARY}[]`,
    }),
    route(
      'GET',
      `${root}/threads/:id`,
      `${ns}.threads.get`,
      { query: null, body: null, response: `${THREAD_DETAIL} | null` },
      [{ name: 'id', source: 'path' }],
    ),
    route(
      'DELETE',
      `${root}/threads/:id`,
      `${ns}.threads.remove`,
      { query: null, body: null, response: 'void' },
      [{ name: 'id', source: 'path' }],
    ),
    route(
      'POST',
      `${root}/threads/:id/fork-from/:messageId`,
      `${ns}.threads.fork`,
      { query: null, body: null, response: THREAD_SUMMARY },
      [
        { name: 'id', source: 'path' },
        { name: 'messageId', source: 'path' },
      ],
    ),
    route(
      'PATCH',
      `${root}/threads/:id`,
      `${ns}.threads.rename`,
      { query: null, body: '{ title: string }', response: '{ ok: boolean }' },
      [{ name: 'id', source: 'path' }],
    ),
    route(
      'POST',
      `${root}/threads/:id/promote`,
      `${ns}.threads.promote`,
      { query: null, body: null, response: '{ ok: boolean }' },
      [{ name: 'id', source: 'path' }],
    ),
    route(
      'DELETE',
      `${root}/threads/:id/from/:messageId`,
      `${ns}.threads.truncate`,
      { query: null, body: null, response: '{ ok: boolean }' },
      [
        { name: 'id', source: 'path' },
        { name: 'messageId', source: 'path' },
      ],
    ),
    route('POST', `${root}/tool-call/approve`, `${ns}.toolCall.approve`, {
      query: null,
      body: '{ runId: string; toolCallId: string }',
      response: 'void',
    }),
    route('POST', `${root}/tool-call/reject`, `${ns}.toolCall.reject`, {
      query: null,
      body: '{ runId: string; toolCallId: string; reason?: string }',
      response: 'void',
    }),
    route(
      'GET',
      `${root}/skills`,
      `${ns}.skills.list`,
      {
        query: '{ threadId?: string }',
        body: null,
        response: `${SKILL_CATALOG_ENTRY}[]`,
      },
      [{ name: 'threadId', source: 'query' }],
    ),
    route(
      'GET',
      `${root}/memories`,
      `${ns}.memories.list`,
      {
        query: '{ threadId?: string }',
        body: null,
        response: `${MEMORY_ENTRY}[]`,
      },
      [{ name: 'threadId', source: 'query' }],
    ),
    route(
      'DELETE',
      `${root}/memories/:id`,
      `${ns}.memories.forget`,
      { query: null, body: null, response: '{ forgotten: boolean }' },
      [{ name: 'id', source: 'path' }],
    ),
    route('POST', `${root}/tool-call/answer`, `${ns}.toolCall.answer`, {
      query: null,
      body: '{ toolCallId: string; answers?: Record<string, string[]> }',
      response: '{ ok: boolean }',
    }),
    route('POST', `${root}/tool-call/skip`, `${ns}.toolCall.skip`, {
      query: null,
      body: '{ toolCallId: string }',
      response: '{ ok: boolean }',
    }),
    route('GET', `${root}/attachments`, `${ns}.attachments.list`, {
      query: null,
      body: null,
      response: `${STAGED_ATTACHMENT}[]`,
    }),
    route('GET', `${root}/quota/today`, `${ns}.quota`, {
      query: null,
      body: null,
      response: '{ usedTokens: number }',
    }),
    route(
      'POST',
      `${root}/chat/:runId/cancel`,
      `${ns}.chat.cancel`,
      { query: null, body: null, response: '{ aborted: boolean }' },
      [{ name: 'runId', source: 'path' }],
    ),
  ];
}

/**
 * A [`@dudousxd/nestjs-codegen`](https://www.npmjs.com/package/@dudousxd/nestjs-codegen) extension
 * that emits the `@dudousxd/nestjs-agent` JSON REST routes (agents catalog, threads incl.
 * rename/promote/fork/truncate, tool-call approve/reject/answer/skip, skills, memories, staged
 * attachments, quota, cancel) into your generated `api.ts` — so they're available as a typed client
 * / TanStack hooks in your frontend.
 *
 * It injects the routes directly, because the agent controllers live in `node_modules` where static
 * AST discovery can't see them. Three endpoints are deliberately left out, and
 * `covers-every-json-route.spec.ts` fails on any fourth that goes missing by accident: the streaming
 * `POST /agent/chat` and `GET /agent/chat/:runId/stream` — use `@dudousxd/nestjs-agent-react`'s
 * `useAgentChat` (a Vercel AI SDK transport) — and `POST /agent/attachments`, a multipart upload
 * where codegen models JSON bodies.
 *
 * ```ts
 * defineConfig({ extensions: [nestjsAgentCodegen({ basePath: '/api' })] });
 * ```
 */
export function nestjsAgentCodegen(options: AgentCodegenOptions = {}): AgentCodegenExtension {
  const base = (options.basePath ?? '').replace(/\/+$/, '');
  const ns = options.name ?? 'agent';
  const injected = agentRoutes(base, ns);

  return {
    name: 'nestjs-agent',
    transformRoutes(routes) {
      return [...routes, ...injected];
    },
  };
}
