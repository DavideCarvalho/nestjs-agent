import type { RouteDescriptor } from '@dudousxd/nestjs-codegen';
import type { CodegenExtension } from '@dudousxd/nestjs-codegen/extension';

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

// Wire shapes returned by the JSON endpoints (dates are ISO strings over the wire). The deeply
// nested tool-call/usage payloads are intentionally loose — the typed surface that matters to a
// frontend is the thread/message envelope; rich tool data flows through the React tool-part renderer.
const USAGE =
  '{ inputTokens: number; outputTokens: number; totalTokens?: number; costUsd?: number }';
const STORED_MESSAGE = `{ id: string; role: string; content: string; toolCalls?: Record<string, unknown>[]; toolResults?: Record<string, unknown>[]; followUps?: string[]; usage?: ${USAGE}; createdAt: string }`;
const THREAD_SUMMARY =
  '{ id: string; title: string; persona: string; transient: boolean; ' +
  'createdAt: string; updatedAt: string; lastMessagePreview?: string }';
const THREAD_DETAIL = `${THREAD_SUMMARY.slice(0, -2)}; messages: ${STORED_MESSAGE}[]; activeStreamId?: string }`;
const PERSONA = '{ id: string; label: string }';

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
    route('GET', `${root}/threads`, `${ns}.threads.list`, {
      query: null,
      body: null,
      response: `${THREAD_SUMMARY}[]`,
    }),
    route('GET', `${root}/threads/personas/catalog`, `${ns}.personas`, {
      query: null,
      body: null,
      response: `${PERSONA}[]`,
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
 * that emits the `@dudousxd/nestjs-agent` JSON REST routes (threads, personas, tool-call
 * approve/reject, quota, cancel) into your generated `api.ts` — so they're available as a typed
 * client / TanStack hooks in your frontend.
 *
 * It injects the routes directly, because the agent controllers live in `node_modules` where static
 * AST discovery can't see them. The streaming `POST /agent/chat` + `GET /agent/chat/:runId/stream`
 * SSE endpoints are deliberately omitted — use `@dudousxd/nestjs-agent-react`'s `useAgentChat`
 * (a Vercel AI SDK transport) for those.
 *
 * ```ts
 * defineConfig({ extensions: [nestjsAgentCodegen({ basePath: '/api' })] });
 * ```
 */
export function nestjsAgentCodegen(options: AgentCodegenOptions = {}): CodegenExtension {
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
