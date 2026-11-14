import { CanAnyone } from '@dudousxd/nestjs-agent-core';
import {
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Query,
  createParamDecorator,
} from '@nestjs/common';
import { DashboardConsoleAccess } from './console-authorize.guard.js';
import { DashboardService } from './dashboard.service.js';
import { DASHBOARD_BASE_PATH } from './tokens.js';

// ── the console registry (v1), re-declared: no Aviary console imports another ──────────────

/** The process-wide slot every Aviary console registers into (created by whichever boots first). */
export const AVIARY_CONSOLES_SLOT = Symbol.for('@dudousxd/aviary:consoles');

/** The icon a console shows in the switcher. An unknown value renders as `generic`. */
export type AviaryConsoleIcon =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'generic';

/** What a console's `authorize` answers; only `allowed: true` lists it. */
export interface AviaryConsoleDecision {
  allowed: boolean;
  reason?: string;
  redirectTo?: string;
}

/** One console the switcher can list. */
export interface AviaryConsoleEntry {
  /** `/^[a-z][a-z0-9-]*$/`: `'durable'`, `'telescope'`, `'agent'`, `'media'`, … */
  id: string;
  /** Product title: `'Workflows'`, `'Telescope'`, `'Agents'`, `'Media'`. */
  title: string;
  icon: AviaryConsoleIcon;
  /** Same-origin absolute path of the console's page (`/ai-gateway`). */
  path: string;
  /** Sort key: durable 10, telescope 20, agent 30, media 50. */
  order: number;
  /** The console's resolved gate (what its own routes run). Never throws. */
  authorize(context: ExecutionContext): Promise<AviaryConsoleDecision>;
  /**
   * Global search: at most `limit` hits for `q` in this console, scoped like the console's own reads
   * (tenancy included), each linking to a same-origin page of the console. Optional.
   */
  search?(context: ExecutionContext, q: string, limit: number): Promise<AviaryConsoleSearchHit[]>;
}

/** One global-search hit. `href` is a same-origin absolute path. */
export interface AviaryConsoleSearchHit {
  title: string;
  subtitle?: string;
  href: string;
}

/** One console's hits, as `GET <api>/consoles/search` returns them. */
export interface AviaryConsoleSearchGroup {
  id: string;
  title: string;
  icon: AviaryConsoleIcon;
  hits: AviaryConsoleSearchHit[];
}

/** The answer of `GET <api>/consoles/search?q=`. */
export interface AviaryConsoleSearchResult {
  version: 1;
  q: string;
  /** The consoles that answered with at least one hit, by `order` then `id`. */
  results: AviaryConsoleSearchGroup[];
  /** `true` when a console that may be searched timed out or failed: the results may miss hits. */
  partial: boolean;
}

/** The value at {@link AVIARY_CONSOLES_SLOT}. Data only, so every console's copy is identical. */
export interface AviaryConsoleRegistry {
  readonly version: 1;
  readonly entries: AviaryConsoleEntry[];
}

/** One console as `GET <api>/consoles` returns it. */
export interface VisibleConsole {
  id: string;
  title: string;
  icon: AviaryConsoleIcon;
  href: string;
}

/** The answer of `GET <api>/consoles`. */
export interface VisibleConsoles {
  version: 1;
  current: string;
  consoles: VisibleConsole[];
}

/** The `switcher` field of the shell's config block. */
export interface ConsoleSwitcherConfig {
  endpoint: string;
  others: number;
}

const ID = /^[a-z][a-z0-9-]*$/;
const ICONS = new Set<string>([
  'workflow',
  'telescope',
  'media',
  'payments',
  'agent',
  'identity',
  'generic',
]);

/** How long another console's `authorize` may take before it is left out. */
export const CONSOLE_PROBE_TIMEOUT_MS = 300;

/** How long one console's `search` may take before it is left out (the result reads `partial`). */
export const CONSOLE_SEARCH_TIMEOUT_MS = 300;

/** Hits kept per console. */
export const CONSOLE_SEARCH_LIMIT = 5;

/** Longest query a search fans out (longer ones are cut). */
const MAX_QUERY_LENGTH = 200;

/**
 * Runs `fn` with `request.aviaryProbe = true` on the request behind `context`: what the switcher
 * sets while it runs ANOTHER console's `authorize` to list or search it, so an authorizer that writes
 * an audit log line can tell a probe from a real visit and skip it. Structural: any console reads
 * `request.aviaryProbe === true`.
 */
export async function withAviaryProbe<T>(
  context: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  let request: { aviaryProbe?: boolean } | undefined;
  try {
    request = context.switchToHttp().getRequest<{ aviaryProbe?: boolean } | undefined>();
  } catch {
    request = undefined;
  }
  if (request === null || typeof request !== 'object' || request.aviaryProbe === true) return fn();
  request.aviaryProbe = true;
  try {
    return await fn();
  } finally {
    Reflect.deleteProperty(request, 'aviaryProbe');
  }
}

/** `promise`'s value within `ms`, else `timedOut`; a rejection is `failed`. */
async function within<T>(
  promise: () => Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(promise)
        .then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The usable hits of a search answer: same-origin `href`s, string titles, at most `limit`. */
export function sanitizeSearchHits(value: unknown, limit: number): AviaryConsoleSearchHit[] {
  if (!Array.isArray(value)) return [];
  const hits: AviaryConsoleSearchHit[] = [];
  for (const item of value) {
    if (hits.length >= limit) break;
    if (typeof item !== 'object' || item === null) continue;
    const hit = item as Record<string, unknown>;
    if (typeof hit.title !== 'string' || hit.title === '' || !isSameOriginPath(hit.href)) continue;
    hits.push({
      title: hit.title,
      ...(typeof hit.subtitle === 'string' && hit.subtitle !== ''
        ? { subtitle: hit.subtitle }
        : {}),
      href: hit.href,
    });
  }
  return hits;
}

/**
 * Global search: `selfId`'s own `search` (the viewer is already in this console) and every other
 * console with a `search` whose `authorize` allows the viewer (run as a probe, see
 * {@link withAviaryProbe}). Each console gets `timeoutMs` for its `authorize` and again for its
 * `search`, and keeps `limit` hits; a console that times out or fails is left out and marks the
 * answer `partial`. A denial is not partial: it is simply not searched. The gates run in parallel,
 * then the searches in parallel, so no `search` ever runs while the request carries the probe.
 * `only` (a console id) limits the search to that one console, still behind its own `authorize`.
 */
export async function searchConsoles(
  registry: AviaryConsoleRegistry | undefined,
  selfId: string,
  context: ExecutionContext,
  query: string,
  options: { timeoutMs?: number; limit?: number; only?: unknown } = {},
): Promise<AviaryConsoleSearchResult> {
  const q = query.trim().slice(0, MAX_QUERY_LENGTH);
  const timeoutMs = options.timeoutMs ?? CONSOLE_SEARCH_TIMEOUT_MS;
  const limit = options.limit ?? CONSOLE_SEARCH_LIMIT;
  if (q === '') return { version: 1, q, results: [], partial: false };
  // `only`: one console's hits (⌘K asks each console on its own and streams the groups in).
  const one = typeof options.only === 'string' && options.only !== '' ? options.only : undefined;
  const searchable = (registry?.entries ?? [])
    .filter(
      (entry) =>
        typeof entry.search === 'function' &&
        isSameOriginPath(entry.path) &&
        (one === undefined || entry.id === one),
    )
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  // First every other console's gate, as a probe (in parallel, one budget each); then the searches,
  // never under the probe marker: a search is a real use of the console, not a visibility check.
  const gates = await withAviaryProbe(context, () =>
    Promise.all(
      searchable.map(async (entry) =>
        entry.id === selfId
          ? ('allowed' as const)
          : await within(() => entry.authorize(context), timeoutMs).then((gate) =>
              !gate.ok
                ? ('late' as const)
                : gate.value?.allowed === true
                  ? ('allowed' as const)
                  : ('denied' as const),
            ),
      ),
    ),
  );
  const outcomes = await Promise.all(
    searchable.map(async (entry, index) => {
      const gate = gates[index];
      if (gate === 'late') return { entry, hits: [], partial: true };
      if (gate !== 'allowed') return { entry, hits: [], partial: false };
      const found = await within(
        () => (entry.search as NonNullable<AviaryConsoleEntry['search']>)(context, q, limit),
        timeoutMs,
      );
      return found.ok
        ? { entry, hits: sanitizeSearchHits(found.value, limit), partial: false }
        : { entry, hits: [], partial: true };
    }),
  );
  return {
    version: 1,
    q,
    results: outcomes
      .filter((outcome) => outcome.hits.length > 0)
      .map(({ entry, hits }) => ({
        id: entry.id,
        title: entry.title,
        icon: ICONS.has(entry.icon) ? entry.icon : 'generic',
        hits,
      })),
    partial: outcomes.some((outcome) => outcome.partial),
  };
}

/**
 * Whether `path` is a same-origin absolute path (`/x`): never `//host`, a URL, a backslash (for
 * http(s) bases `/\evil` parses as `//evil`) or a control character. The kit's `isSafeHref` applies
 * the same rule in the browser.
 */
export function isSameOriginPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\u0000-\u001f\u007f]/.test(path)
  );
}

/** The registry, when one is set with a version this copy reads. */
export function readAviaryConsoles(): AviaryConsoleRegistry | undefined {
  const value = (globalThis as Record<symbol, unknown>)[AVIARY_CONSOLES_SLOT] as
    | Partial<AviaryConsoleRegistry>
    | undefined;
  if (value?.version !== 1 || !Array.isArray(value.entries)) return undefined;
  return value as AviaryConsoleRegistry;
}

/**
 * Adds a console to the process's switcher registry, creating it when absent. Returns a function
 * that removes the entry again, or `undefined` when it was not added (another registry version, or
 * the id is taken: logged as a warning). A bad `id` or `path` throws.
 */
export function registerAviaryConsole(
  entry: AviaryConsoleEntry,
  logger?: { warn(message: string): void },
): (() => void) | undefined {
  if (!ID.test(entry.id)) throw new Error(`console id ${JSON.stringify(entry.id)} is invalid`);
  if (!isSameOriginPath(entry.path)) {
    throw new Error(`console path ${JSON.stringify(entry.path)} must start with a single "/"`);
  }
  const holder = globalThis as Record<symbol, unknown>;
  if (holder[AVIARY_CONSOLES_SLOT] === undefined) {
    const fresh: AviaryConsoleRegistry = { version: 1, entries: [] };
    holder[AVIARY_CONSOLES_SLOT] = fresh;
  }
  const registry = readAviaryConsoles();
  if (registry === undefined) return undefined;
  if (registry.entries.some((existing) => existing.id === entry.id)) {
    logger?.warn(`console id "${entry.id}" is already registered`);
    return undefined;
  }
  registry.entries.push(entry);
  return () => {
    const index = registry.entries.indexOf(entry);
    if (index !== -1) registry.entries.splice(index, 1);
  };
}

/** The shell's `switcher` config: only when another console is registered (no `authorize` runs). */
export function consoleSwitcherConfig(
  selfId: string,
  endpoint: string,
): ConsoleSwitcherConfig | undefined {
  const registry = readAviaryConsoles();
  if (!registry?.entries.some((entry) => entry.id === selfId)) return undefined;
  const others = registry.entries.filter((entry) => entry.id !== selfId).length;
  return others > 0 ? { endpoint, others } : undefined;
}

/** Whether `entry` allows the viewer within `ms`; a rejection or a timeout is a no. */
async function allows(
  entry: AviaryConsoleEntry,
  context: ExecutionContext,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => entry.authorize(context))
        .then(
          (decision) => decision?.allowed === true,
          () => false,
        ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The consoles other than `selfId` the viewer may open, by `order` then `id`. Every other entry's
 * `authorize` runs in parallel, each given `timeoutMs`; a timeout, a rejection or any denial hides
 * it. No reason is ever returned.
 */
export async function listVisibleConsoles(
  registry: AviaryConsoleRegistry | undefined,
  selfId: string,
  context: ExecutionContext,
  timeoutMs = CONSOLE_PROBE_TIMEOUT_MS,
): Promise<VisibleConsoles> {
  const others = (registry?.entries ?? [])
    .filter((entry) => entry.id !== selfId && isSameOriginPath(entry.path))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  // A probe, not a visit: an authorizer that audits can skip it.
  const verdicts = await withAviaryProbe(context, () =>
    Promise.all(others.map((entry) => allows(entry, context, timeoutMs))),
  );
  return {
    version: 1,
    current: selfId,
    consoles: others
      .filter((_, index) => verdicts[index])
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        icon: ICONS.has(entry.icon) ? entry.icon : 'generic',
        href: entry.path,
      })),
  };
}

// ── the agent console's side ─────────────────────────────────────────────────

/** The agent console's id in the registry. */
export const AGENT_CONSOLE_ID = 'agent';

const logger = new Logger('AgentDashboardModule');

/**
 * Registers the agent console into the switcher registry (the console's page path, gated by its
 * resolved `authorize`). Provided only when the console's routes are mounted; removed on shutdown.
 */
@Injectable()
export class AgentConsoleRegistration implements OnModuleInit, OnModuleDestroy {
  #unregister: (() => void) | undefined;

  constructor(
    @Inject(DASHBOARD_BASE_PATH) private readonly basePath: string,
    private readonly access: DashboardConsoleAccess,
    private readonly dashboard: DashboardService,
  ) {}

  onModuleInit(): void {
    const page = this.basePath === '' ? '/' : this.basePath;
    this.#unregister = registerAviaryConsole(
      {
        id: AGENT_CONSOLE_ID,
        title: 'Agents',
        icon: 'agent',
        order: 30,
        path: page,
        authorize: (context) => this.access.check(context),
        search: (_context, q, limit) => this.dashboard.search(q, limit, page),
      },
      logger,
    );
  }

  onModuleDestroy(): void {
    this.#unregister?.();
    this.#unregister = undefined;
  }
}

/** What the route hands on to the other consoles' `authorize`: this request's `ExecutionContext`. */
interface CurrentContext {
  context: ExecutionContext;
}

const CurrentExecutionContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentContext => ({ context }),
);

/**
 * `GET <api>/consoles`: the other Aviary consoles this viewer may open. Behind the console's own
 * access check, like every API route, so only someone who may open this console learns the list.
 */
@CanAnyone()
@Controller()
export class AgentConsolesController {
  @Get('consoles')
  @Header('Cache-Control', 'private, no-store')
  consoles(@CurrentExecutionContext() current: CurrentContext): Promise<VisibleConsoles> {
    return listVisibleConsoles(readAviaryConsoles(), AGENT_CONSOLE_ID, current.context);
  }

  /**
   * `GET <api>/consoles/search?q=`: this console's hits and those of every other console the viewer
   * may open, 5 each, each console given 300 ms. `partial: true` when one did not answer in time.
   * `&console=<id>` answers for that one console only, so the SPA can stream each console's group
   * in as it arrives.
   */
  @Get('consoles/search')
  @Header('Cache-Control', 'private, no-store')
  search(
    @CurrentExecutionContext() current: CurrentContext,
    @Query('q') q?: string,
    @Query('console') only?: unknown,
  ): Promise<AviaryConsoleSearchResult> {
    return searchConsoles(
      readAviaryConsoles(),
      AGENT_CONSOLE_ID,
      current.context,
      typeof q === 'string' ? q : '',
      { only },
    );
  }
}
