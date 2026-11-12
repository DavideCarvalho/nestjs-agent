import type { ExecutionContext } from '@nestjs/common';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DashboardConsoleAccess } from './console-authorize.guard.js';
import type { ConsoleDecision } from './console-authorize.js';
import { DashboardService } from './dashboard.service.js';
import { DASHBOARD_DEV_TOOLS } from './tokens.js';

// ── the dev-tools contract (v1), re-declared: this package never imports the MCP server ──────

/** The process-wide slot `@dudousxd/nestjs-agent-mcp-server` serves on its dev MCP endpoint. */
const DEV_TOOLS_SLOT = Symbol.for('@dudousxd/aviary:dev-tools');

interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

/** One developer tool, as the dev-tools slot takes it. */
export interface AgentDevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  run(input: Record<string, unknown>): Promise<unknown>;
}

interface DevToolsLib {
  lib: string;
  title: string;
  authorize(context: ExecutionContext): Promise<ConsoleDecision>;
  tools: AgentDevTool[];
}

interface DevToolsSlot {
  readonly version: 1;
  readonly libs: DevToolsLib[];
  register(lib: DevToolsLib): () => void;
}

/** The slot, created when absent (whoever loads first creates it). */
function devToolsSlot(): Partial<DevToolsSlot> {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[DEV_TOOLS_SLOT] as Partial<DevToolsSlot> | undefined;
  if (existing !== undefined) return existing;
  const libs: DevToolsLib[] = [];
  const slot: DevToolsSlot = {
    version: 1,
    libs,
    register(lib) {
      if (libs.some((entry) => entry.lib === lib.lib)) {
        throw new Error(`dev tools: the lib "${lib.lib}" is already registered`);
      }
      libs.push(lib);
      return () => {
        const index = libs.indexOf(lib);
        if (index !== -1) libs.splice(index, 1);
      };
    },
  };
  holder[DEV_TOOLS_SLOT] = slot;
  return slot;
}

// ── the agent's own tools ──────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Messages `agent_get_run` returns with `includeMessages: true`, each cut to 2 KB. */
const MESSAGE_LIMIT = 50;
const MESSAGE_BYTES = 2 * 1024;
const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const day: DevToolInputProperty = { type: 'string', description: 'UTC day, YYYY-MM-DD.' };
const page: DevToolInputProperty = {
  type: 'integer',
  description: 'Page, from 1. Pass the `next` of the previous page.',
  minimum: 1,
};
const limit: DevToolInputProperty = {
  type: 'integer',
  description: `Rows per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
  minimum: 1,
  maximum: MAX_LIMIT,
};

const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

function dayOf(input: Record<string, unknown>, key: string): string | undefined {
  const value = str(input[key]);
  if (value !== undefined && !ISO_DAY.test(value)) throw new Error(`"${key}" must be YYYY-MM-DD`);
  return value;
}

/** `from`/`to`, defaulting to the last 30 days like the console. */
function rangeOf(input: Record<string, unknown>) {
  const utcDay = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
  return { fromDay: dayOf(input, 'from') ?? utcDay(29), toDay: dayOf(input, 'to') ?? utcDay(0) };
}

function pageOf(input: Record<string, unknown>) {
  return {
    page: typeof input.page === 'number' ? input.page : 1,
    pageSize: typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT,
  };
}

/** Only the filters that were given (`exactOptionalPropertyTypes`). */
function where<T extends Record<string, string | undefined>>(fields: T) {
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return Object.keys(set).length > 0 ? { where: set as { [K in keyof T]?: string } } : {};
}

/** A console page as a dev-tools list: `{ items, next, total }`. */
function listOf<Row>(result: { rows: Row[]; total: number; page: number; pageSize: number }) {
  return {
    items: result.rows,
    next: result.page * result.pageSize < result.total ? result.page + 1 : null,
    total: result.total,
  };
}

function cut(text: string, maxBytes: number): string {
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= maxBytes) return text;
  const suffix = `…(truncated, ${size} bytes)`;
  const keep = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let head = Buffer.from(text, 'utf8').subarray(0, keep).toString('utf8');
  if (head.endsWith('�')) head = head.slice(0, -1);
  return `${head}${suffix}`;
}

/**
 * The agent's developer tools (lib `agent`): the governance console's reads, through the same
 * {@link DashboardService} methods its API serves. No actions: approving a tool call over MCP would
 * bypass the human approval it exists for.
 */
export function agentDevTools(dashboard: DashboardService): AgentDevTool[] {
  return [
    {
      name: 'agent_list_runs',
      kind: 'read',
      description:
        'Agent runs, newest first: agent, actor, status, duration, cost, error. Filters: agent, status, errorCode, threadId, from/to (UTC days). Returns { items, next, total }; pass next as page.',
      input: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent name.' },
          status: { type: 'string', enum: ['running', 'completed', 'failed', 'cancelled'] },
          errorCode: { type: 'string' },
          threadId: { type: 'string' },
          from: day,
          to: day,
          page,
          limit,
        },
      },
      async run(input) {
        return listOf(
          await dashboard.runsPage({
            ...pageOf(input),
            ...where({
              agentName: str(input.agent),
              status: str(input.status),
              errorCode: str(input.errorCode),
              threadId: str(input.threadId),
              fromDay: dayOf(input, 'from'),
              toDay: dayOf(input, 'to'),
            }),
          }),
        );
      },
    },
    {
      name: 'agent_get_run',
      kind: 'read',
      description:
        "One run: the run, its thread, its tool calls and timings. With includeMessages: true, the thread's latest 50 messages, each cut to 2 KB. An error when no run has that id.",
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Run id.' },
          includeMessages: { type: 'boolean', description: 'Include messages (default false).' },
        },
        required: ['id'],
      },
      async run(input) {
        let detail: Awaited<ReturnType<DashboardService['runDetail']>>;
        try {
          detail = await dashboard.runDetail(String(input.id));
        } catch (error) {
          // The endpoint answers a throw as an MCP `isError` result.
          if (error instanceof NotFoundException)
            throw new Error(`run ${String(input.id)} not found`);
          throw error;
        }
        if (input.includeMessages !== true) return detail;
        const thread = await dashboard.threadDetail({
          threadId: detail.run.threadId,
          messageLimit: MESSAGE_LIMIT,
          runLimit: 1,
        });
        return {
          ...detail,
          messages: thread.messages.map((message) => ({
            ...message,
            content: cut(message.content, MESSAGE_BYTES),
          })),
        };
      },
    },
    {
      name: 'agent_get_spend',
      kind: 'read',
      description:
        'Tokens and cost over UTC days from/to (default the last 30 days): by model, by actor, by feature and the daily trend. `by` returns one of them.',
      input: {
        type: 'object',
        properties: {
          by: { type: 'string', enum: ['model', 'actor', 'feature'] },
          from: day,
          to: day,
        },
      },
      async run(input) {
        const spend = await dashboard.spend(rangeOf(input));
        switch (input.by) {
          case 'model':
            return { items: spend.byModel };
          case 'actor':
            return { items: spend.byActor };
          case 'feature':
            return { items: spend.byFeature ?? [] };
          default:
            return spend;
        }
      },
    },
    {
      name: 'agent_get_tool_stats',
      kind: 'read',
      description:
        'Per tool: calls, failures, rejections and latency, over UTC days from/to (default the last 30 days).',
      input: { type: 'object', properties: { from: day, to: day } },
      async run(input) {
        return { items: await dashboard.toolStats(rangeOf(input)) };
      },
    },
    {
      name: 'agent_get_reliability',
      kind: 'read',
      description:
        'Run metrics, by-agent and by-error breakdowns and the trend, over UTC days from/to (default the last 30 days).',
      input: { type: 'object', properties: { from: day, to: day } },
      async run(input) {
        return dashboard.reliability(rangeOf(input));
      },
    },
    {
      name: 'agent_list_pending_approvals',
      kind: 'read',
      description:
        'Tool calls waiting for a human approval, oldest first. Read-only: approve them in the app. Returns { items, next, total }.',
      input: {
        type: 'object',
        properties: {
          toolName: { type: 'string' },
          agent: { type: 'string', description: 'Agent name.' },
          actor: { type: 'string', description: 'Actor ref of the thread owner.' },
          threadId: { type: 'string' },
          from: day,
          to: day,
          page,
          limit,
        },
      },
      async run(input) {
        return listOf(
          await dashboard.approvalsPage({
            ...pageOf(input),
            ...where({
              toolName: str(input.toolName),
              agentName: str(input.agent),
              actorRef: str(input.actor),
              threadId: str(input.threadId),
              fromDay: dayOf(input, 'from'),
              toDay: dayOf(input, 'to'),
            }),
          }),
        );
      },
    },
    {
      name: 'agent_list_recent_tool_calls',
      kind: 'read',
      description:
        'Tool calls of every agent, newest first. Filters: toolName, status, threadId, from/to (UTC days). Returns { items, next, total }.',
      input: {
        type: 'object',
        properties: {
          toolName: { type: 'string' },
          status: { type: 'string' },
          threadId: { type: 'string' },
          from: day,
          to: day,
          page,
          limit,
        },
      },
      async run(input) {
        return listOf(
          await dashboard.toolCallsPage({
            ...pageOf(input),
            ...where({
              toolName: str(input.toolName),
              status: str(input.status),
              threadId: str(input.threadId),
              fromDay: dayOf(input, 'from'),
              toDay: dayOf(input, 'to'),
            }),
          }),
        );
      },
    },
  ];
}

const logger = new Logger('AgentDashboardModule');

/**
 * Registers the agent's tools into the dev-tools slot, gated by the console's own resolved
 * `authorize`, when the console is mounted (or `devTools: true`). Removed again on shutdown.
 */
@Injectable()
export class AgentDevToolsRegistration implements OnModuleInit, OnModuleDestroy {
  #unregister: (() => void) | undefined;

  constructor(
    @Inject(DASHBOARD_DEV_TOOLS) private readonly enabled: boolean,
    private readonly dashboard: DashboardService,
    private readonly access: DashboardConsoleAccess,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) return;
    const slot = devToolsSlot();
    if (slot.version !== 1 || typeof slot.register !== 'function') return;
    try {
      this.#unregister = slot.register({
        lib: 'agent',
        title: 'Agent governance',
        authorize: (context) => this.access.check(context),
        tools: agentDevTools(this.dashboard),
      });
    } catch (error) {
      // Another application in this process registered the agent's tools: keep the console up.
      logger.warn(
        `agent dev tools not registered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.#unregister?.();
    this.#unregister = undefined;
  }
}
