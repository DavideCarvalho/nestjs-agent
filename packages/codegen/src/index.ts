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
/** A server-pushed component — mirrors `AgentUiComponent` in core/src/stream-events.ts. */
const UI_COMPONENT =
  '{ id: string; component: string; props: Record<string, unknown>; version?: number }';
/** `StoredMessage.feedback` / `POST /agent/messages/:id/feedback` — mirrors `MessageFeedback` in core/src/types.ts. */
const MESSAGE_FEEDBACK = "{ value: 'up' | 'down'; comment?: string; updatedAt: string }";
const STORED_MESSAGE = `{ id: string; role: 'user' | 'assistant' | 'system'; content: string; agentName?: string; persona?: string; toolCalls?: Record<string, unknown>[]; toolResults?: Record<string, unknown>[]; followUps?: string[]; usage?: ${USAGE}; reasoning?: string; reasoningMs?: number; ui?: ${UI_COMPONENT}[]; feedback?: ${MESSAGE_FEEDBACK}; createdAt: string }`;
const THREAD_SUMMARY =
  '{ id: string; title: string; transient: boolean; ' +
  'createdAt: string; updatedAt: string; lastMessagePreview?: string; ' +
  'defaultAgent?: string | null; activeRunId?: string | null; model?: string | null; persona?: string | null }';
const ATTACHMENT = '{ mediaId: string; url: string; contentType: string; name: string }';
/** Mirrors `ChatQueueState` in core/src/spi/chat-queue.ts. */
const CHAT_QUEUE_STATE = `{ items: { id: string; content: string; attachments?: ${ATTACHMENT}[]; agentName?: string; persona?: string; model?: string; interrupt?: boolean; createdAt: string; updatedAt: string }[]; paused: { reason: 'run_failed' | 'cancelled' | 'quota_exceeded' | 'start_failed'; message?: string; at: string } | null }`;
const THREAD_DETAIL = `${THREAD_SUMMARY.slice(0, -2)}; messages: ${STORED_MESSAGE}[]; queue?: ${CHAT_QUEUE_STATE} }`;
/** `GET /agent/config` — mirrors `AgentClientConfig` in nestjs/src/controller/config.controller.ts. */
const CLIENT_CONFIG =
  "{ attachments: { enabled: boolean; upload: 'multipart' | 'resumable' | null; maxBytes: number; " +
  'allowedContentTypes: string[]; maxPerMessage: number }; models: { enabled: boolean }; ' +
  'quota: { enforced: boolean }; identity: { anonymous: boolean } }';
/** `GET /agent/quota` — mirrors `QuotaReport` in core/src/spi/quota-provider.ts. */
const QUOTA_REPORT =
  "{ windows: { period: 'day' | 'month'; usedTokens?: number; limitTokens?: number; usedUsd: number; " +
  "limitUsd?: number; resetsAt?: string; warnAt?: number }[]; blocked?: { period: 'day' | 'month'; reason?: string }; " +
  "warning?: { period: 'day' | 'month'; ratio: number; reason?: string } }";
/** `GET /agent/models` — mirrors `ModelCatalogView` in core/src/spi/model-catalog.ts. */
const MODEL_CATALOG_VIEW =
  '{ default: string | null; providers: { id: string; label: string; models: { id: string; ' +
  'label: string; description?: string; badges?: string[]; available: boolean; ' +
  'unavailableReason?: string; contextWindow?: number }[] }[]; locked?: { model: string; reason?: string } }';
/** The `GET /agent/agents` catalog entry — mirrors `AgentCatalogEntry` in core/src/types.ts. */
const AGENT_CATALOG_ENTRY =
  '{ name: string; description: string; isDefault?: boolean; lockedModel?: string; ' +
  'personas?: { id: string; label: string; description?: string }[]; defaultPersona?: string }';

const TOOL_RESULT_FIELD = '{ path: string; label: string; unit?: string }';
/** Mirrors `ToolResultView` in core/src/tool-presentation.ts. */
const TOOL_RESULT_VIEW = `{ kind: 'metrics'; fields: ${TOOL_RESULT_FIELD}[] } | { kind: 'table'; columns: ${TOOL_RESULT_FIELD}[]; rows: string; empty?: string } | { kind: 'log'; lines: string } | { kind: 'note'; text: string } | { kind: 'elsewhere' }`;
/** Mirrors `ToolPresentation` in core/src/tool-presentation.ts. */
const TOOL_PRESENTATION = `{ label: string; running: string; done: string; icon?: string; detail?: string; tone?: 'neutral' | 'destructive'; confirm?: { title: string; verb: string; detail?: string }; result?: ${TOOL_RESULT_VIEW} }`;
/** `GET /agent/tools` — mirrors `ToolCatalogEntry` in core/src/tool-presentation.ts. */
const TOOL_CATALOG_ENTRY = `{ name: string; kind: 'read' | 'action' | 'agent' | 'ask' | 'skill' | 'memory'; presentation?: ${TOOL_PRESENTATION} }`;

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

/** Mirrors `ToolConfirmation` in core/src/tool-presentation.ts. */
const TOOL_CONFIRMATION = '{ title: string; verb: string; detail?: string }';
/**
 * `GET /agent/threads/:threadId/action-proposals` — mirrors `ActionProposalView` in
 * core/src/action-proposal-view.ts. The audit and outcome stay loose: what a
 * frontend branches on is the decision and the execution status.
 */
const ACTION_PROPOSAL = `{ id: string; tenantRef: string | null; actorRef: string; threadId: string; originRunId: string; originMessageId: string; originToolCallId: string; toolName: string; input: unknown; confirmation: ${TOOL_CONFIRMATION}; approver: string; expiresAt: number | null; replacementKey?: string; decision: 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded'; decisionAudit: Record<string, unknown> | null; execution: { status: 'queued' | 'executing' | 'succeeded' | 'failed'; generation: number; result?: unknown; error?: string } | null; supersededBy?: string; outcome?: Record<string, unknown>; createdAt: number; updatedAt: number }`;
/** `POST …/action-proposals/:proposalId/approve|reject` — mirrors `ActionProposalMutationView`. */
const ACTION_PROPOSAL_MUTATION = `{ status: 'applied' | 'unchanged' | 'conflict' | 'not_found' | 'expired'; proposal?: ${ACTION_PROPOSAL} }`;

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
    route(
      'GET',
      `${root}/models`,
      `${ns}.models.list`,
      { query: '{ agent?: string }', body: null, response: MODEL_CATALOG_VIEW },
      [{ name: 'agent', source: 'query' }],
    ),
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
      {
        query: null,
        body: '{ title?: string; defaultAgent?: string | null; model?: string | null; persona?: string | null }',
        response: '{ ok: boolean }',
      },
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
      `${root}/tools`,
      `${ns}.tools.list`,
      {
        query: '{ agent?: string }',
        body: null,
        response: `${TOOL_CATALOG_ENTRY}[]`,
      },
      [{ name: 'agent', source: 'query' }],
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
    route(
      'POST',
      `${root}/messages/:id/feedback`,
      `${ns}.messages.feedback`,
      {
        query: null,
        body: "{ value: 'up' | 'down' | null; comment?: string }",
        response: `{ feedback: ${MESSAGE_FEEDBACK} | null }`,
      },
      [{ name: 'id', source: 'path' }],
    ),
    route('GET', `${root}/quota`, `${ns}.quota.report`, {
      query: null,
      body: null,
      response: QUOTA_REPORT,
    }),
    route('GET', `${root}/config`, `${ns}.config`, {
      query: null,
      body: null,
      response: CLIENT_CONFIG,
    }),
    route(
      'GET',
      `${root}/threads/:id/queue`,
      `${ns}.queue.get`,
      { query: null, body: null, response: CHAT_QUEUE_STATE },
      [{ name: 'id', source: 'path' }],
    ),
    route(
      'DELETE',
      `${root}/threads/:id/queue`,
      `${ns}.queue.clear`,
      { query: null, body: null, response: CHAT_QUEUE_STATE },
      [{ name: 'id', source: 'path' }],
    ),
    route(
      'POST',
      `${root}/threads/:id/queue/resume`,
      `${ns}.queue.resume`,
      { query: null, body: null, response: `${CHAT_QUEUE_STATE.slice(0, -2)}; runId?: string }` },
      [{ name: 'id', source: 'path' }],
    ),
    route(
      'PATCH',
      `${root}/queue/:messageId`,
      `${ns}.queue.update`,
      {
        query: null,
        body: '{ message?: string; attachments?: { mediaId: string }[] | null; position?: number }',
        response: CHAT_QUEUE_STATE,
      },
      [{ name: 'messageId', source: 'path' }],
    ),
    route(
      'POST',
      `${root}/queue/:messageId/interrupt`,
      `${ns}.queue.interrupt`,
      {
        query: null,
        body: null,
        response: `${CHAT_QUEUE_STATE.slice(0, -2)}; runId?: string; interrupting?: string }`,
      },
      [{ name: 'messageId', source: 'path' }],
    ),
    route(
      'DELETE',
      `${root}/queue/:messageId`,
      `${ns}.queue.remove`,
      { query: null, body: null, response: CHAT_QUEUE_STATE },
      [{ name: 'messageId', source: 'path' }],
    ),
    // One page per call: the next page's cursor travels in the `X-Action-Proposals-Next` response
    // header, which a generated client does not surface — `AgentClient.listActionProposals` follows it.
    route(
      'GET',
      `${root}/threads/:threadId/action-proposals`,
      `${ns}.actionProposals.list`,
      { query: '{ after?: string }', body: null, response: `${ACTION_PROPOSAL}[]` },
      [
        { name: 'threadId', source: 'path' },
        { name: 'after', source: 'query' },
      ],
    ),
    route(
      'POST',
      `${root}/threads/:threadId/action-proposals/:proposalId/approve`,
      `${ns}.actionProposals.approve`,
      { query: null, body: '{ remember?: boolean }', response: ACTION_PROPOSAL_MUTATION },
      [
        { name: 'threadId', source: 'path' },
        { name: 'proposalId', source: 'path' },
      ],
    ),
    route(
      'POST',
      `${root}/threads/:threadId/action-proposals/:proposalId/reject`,
      `${ns}.actionProposals.reject`,
      { query: null, body: '{ reason?: string }', response: ACTION_PROPOSAL_MUTATION },
      [
        { name: 'threadId', source: 'path' },
        { name: 'proposalId', source: 'path' },
      ],
    ),
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
 * rename/promote/fork/truncate, tool-call approve/reject/answer/skip, action proposals
 * list/approve/reject, skills, tools, memories, staged attachments, message feedback, model catalog,
 * quota, the thread message queue, cancel) into your
 * generated `api.ts` — so they're available as a typed client
 * / TanStack hooks in your frontend.
 *
 * It injects the routes directly, because the agent controllers live in `node_modules` where static
 * AST discovery can't see them. A few endpoints are deliberately left out, and
 * `covers-every-json-route.spec.ts` fails on any other that goes missing by accident: the streaming
 * `POST /agent/chat` and `GET /agent/chat/:runId/stream` — use `@dudousxd/nestjs-agent-react`'s
 * `useAgentChat` (a Vercel AI SDK transport) — `POST /agent/attachments`, a multipart upload
 * where codegen models JSON bodies, the opt-in resumable-upload routes
 * (`/agent/attachments/uploads`, driven by the React package's uploader) and the opt-in AG-UI
 * adapter's route.
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
