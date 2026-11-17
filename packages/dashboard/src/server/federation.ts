import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AgentApprovalPort,
  AgentGovernanceQueries,
  AgentPricingStore,
} from '@dudousxd/nestjs-agent-core';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { CONSOLE_APPS } from './console-authorize.js';

/**
 * Another app a federated console shows (see {@link AgentConsoleFederation}). Its threads, runs and
 * tool calls are read from its own store through `queries`; its approve/reject go through
 * `approvals`, which must execute them on the app (`RedisConsoleApprovalClient` from
 * `@dudousxd/nestjs-agent-transport-redis` sends them to the app over its Redis).
 */
export interface FederatedAgentApp {
  /** Shown in the app switcher. Default: the app's name (its key in `apps`). */
  label?: string;
  /**
   * The app's governance read-model over its own database, e.g.
   * `new DrizzleGovernanceQueries(readOnlyDb, new DrizzlePricingStore(readOnlyDb))`. Read access is
   * enough.
   */
  queries: AgentGovernanceQueries;
  /**
   * Approve/reject for the app's approvals inbox, executed on the app. Omitted: the inbox is
   * read-only for this app (`501`).
   */
  approvals?: AgentApprovalPort;
  /** The app's price table, for the Pricing page (read-only). Omitted: `501`. */
  pricing?: Pick<AgentPricingStore, 'listCurrentPrices'>;
}

/**
 * `AgentDashboardModule.forRoot({ federation })`: one console (typically on a central "hub" app)
 * that also shows the agent activity of other apps, each kept in that app's own store and run by
 * that app's own process. The console gets an app switcher, the selected app goes in the URL
 * (`?app=<name>`), and every read and action of a request is served for that app. No app selected
 * is the console's own app, as before.
 */
export interface AgentConsoleFederation {
  /** The other apps, by name: what `?app=` and an `authorize` `apps` grant name. */
  apps: Record<string, FederatedAgentApp>;
  /** How the console's own app is labelled in the switcher. Default `'this app'`. */
  localLabel?: string;
}

/** What `GET <api>/federation` answers: the switcher's view for this viewer. */
export interface ConsoleFederationView {
  local: { label: string };
  /** The apps this viewer may select, in configuration order. */
  apps: Array<{ name: string; label: string }>;
  /** The app this request is for; absent for the console's own app. */
  current?: string;
}

/** DI token carrying the {@link AgentConsoleFederation} (`null`: no federation). */
export const DASHBOARD_FEDERATION = Symbol.for('@dudousxd/nestjs-agent-dashboard:federation');

/** The request header the console's client names the selected app in. */
export const FEDERATED_APP_HEADER = 'x-agent-app';
/** The query parameter that names it where a header can't be sent (the SSE stream, the page). */
export const FEDERATED_APP_PARAM = 'app';

/** The app a console request is for. */
export interface FederatedAppScope {
  name: string;
  app: FederatedAgentApp;
}

const scope = new AsyncLocalStorage<FederatedAppScope>();

/** The federated app the current console request is for, or `undefined` for the console's own app. */
export function currentFederatedApp(): FederatedAppScope | undefined {
  return scope.getStore();
}

/** Run `fn` for the federated app `selected`. */
export function withFederatedApp<T>(selected: FederatedAppScope, fn: () => T): T {
  return scope.run(selected, fn);
}

/** The app a console request selects (header first, then `?app=`), or `undefined` for none. */
export function selectedAppName(request: unknown): string | undefined {
  const req = request as
    | { headers?: Record<string, unknown>; query?: Record<string, unknown> }
    | undefined;
  const header = req?.headers?.[FEDERATED_APP_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader;
  const param = req?.query?.[FEDERATED_APP_PARAM];
  return typeof param === 'string' && param !== '' ? param : undefined;
}

/** The viewer's `apps` grant, left on the request by the console guard (`undefined`: every app). */
export function consoleAppsGrant(request: unknown): readonly string[] | undefined {
  if (typeof request !== 'object' || request === null) return undefined;
  const apps = (request as Record<symbol, unknown>)[CONSOLE_APPS];
  return Array.isArray(apps) ? (apps as string[]) : undefined;
}

/**
 * The federated app `request` selects, checked against the configuration and the viewer's grant.
 * `undefined` when it selects none (or there is no federation); throws a 404 for an app that is not
 * configured or not granted, so the two cannot be told apart.
 */
export function resolveFederatedApp(
  federation: AgentConsoleFederation | null | undefined,
  request: unknown,
): FederatedAppScope | undefined {
  if (!federation) return undefined;
  const name = selectedAppName(request);
  if (name === undefined) return undefined;
  const app = Object.hasOwn(federation.apps, name) ? federation.apps[name] : undefined;
  const grant = consoleAppsGrant(request);
  if (app === undefined || (grant !== undefined && !grant.includes(name))) {
    throw new NotFoundException(`No app "${name}" on this console.`);
  }
  return { name, app };
}

/** Throws at boot on an empty app name or an app without `queries`. */
export function assertValidFederation(federation: AgentConsoleFederation | undefined): void {
  if (federation === undefined) return;
  if (typeof federation.apps !== 'object' || federation.apps === null) {
    throw new Error('AgentDashboardModule: `federation.apps` must be an object keyed by app name.');
  }
  for (const [name, app] of Object.entries(federation.apps)) {
    if (name === '') {
      throw new Error('AgentDashboardModule: every federation app needs a non-empty name.');
    }
    if (typeof app?.queries !== 'object' || app.queries === null) {
      throw new Error(`AgentDashboardModule: federation app "${name}" needs \`queries\`.`);
    }
  }
}

/** The switcher's view of `federation` for a viewer holding `grant`, answering for `current`. */
export function describeFederation(
  federation: AgentConsoleFederation,
  grant: readonly string[] | undefined,
  current: string | undefined,
): ConsoleFederationView {
  return {
    local: { label: federation.localLabel ?? 'this app' },
    apps: Object.entries(federation.apps)
      .filter(([name]) => grant === undefined || grant.includes(name))
      .map(([name, app]) => ({ name, label: app.label ?? name })),
    ...(current !== undefined ? { current } : {}),
  };
}

/**
 * Runs each console API handler for the app its request selects (`x-agent-app` header or `?app=`),
 * so every read and action it makes is served from that app. A no-op without federation or without
 * a selection; an unknown or ungranted app answers 404. Runs after the console guard, which leaves
 * the viewer's `apps` grant on the request.
 */
@Injectable()
export class FederatedAppInterceptor implements NestInterceptor {
  constructor(
    @Optional()
    @Inject(DASHBOARD_FEDERATION)
    private readonly federation?: AgentConsoleFederation | null,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.federation || context.getType() !== 'http') return next.handle();
    const selected = resolveFederatedApp(this.federation, context.switchToHttp().getRequest());
    if (selected === undefined) return next.handle();
    // Subscribing inside the scope runs the handler (and every async continuation it starts) in it.
    return new Observable((subscriber) =>
      withFederatedApp(selected, () => next.handle().subscribe(subscriber)),
    );
  }
}
