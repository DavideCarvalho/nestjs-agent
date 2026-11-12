import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  SetMetadata,
  UseFilters,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import {
  CONSOLE_AUTHORIZE_MISSING_WARNING,
  type ConsoleAccessCheck,
  type ConsoleAuthorize,
  type ConsoleDecision,
  defaultConsoleAccess,
  resolveConsoleAuthorize,
} from './console-authorize.js';
import { DASHBOARD_CONSOLE_OPTIONS } from './tokens.js';

/** What {@link DashboardConsoleAccess} is built from (bound per `forRoot`). */
export interface DashboardConsoleOptions {
  authorize?: ConsoleAuthorize;
  /** Log the boot warning when `authorize` is omitted. */
  warnWhenOmitted: boolean;
}

const logger = new Logger('AgentDashboardModule');

/** Holds the console's resolved `authorize` check for one registration. */
@Injectable()
export class DashboardConsoleAccess implements OnModuleInit {
  #check: ConsoleAccessCheck | undefined;

  constructor(
    @Inject(DASHBOARD_CONSOLE_OPTIONS) private readonly options: DashboardConsoleOptions,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.#check !== undefined) return;
    if (this.options.authorize === undefined) {
      if (this.options.warnWhenOmitted) logger.warn(CONSOLE_AUTHORIZE_MISSING_WARNING);
      this.#check = defaultConsoleAccess(process.env.NODE_ENV === 'production');
      return;
    }
    const check = resolveConsoleAuthorize(this.options.authorize, this.moduleRef);
    await check.ready;
    this.#check = check;
  }

  /** The decision for one request. */
  async check(context: ExecutionContext): Promise<ConsoleDecision> {
    if (this.#check === undefined) await this.onModuleInit();
    return (this.#check as ConsoleAccessCheck)(context);
  }
}

/** Marks a handler as a page the browser navigates to (denials there are HTML / a redirect). */
const CONSOLE_PAGE = Symbol.for('@dudousxd/nestjs-agent-dashboard:console-page');

/** On a handler that serves a page: a denied browser navigation gets HTML or a 302, not JSON. */
export const ConsolePage = (): MethodDecorator => SetMetadata(CONSOLE_PAGE, true);

/** Thrown by {@link ConsoleAuthorizeGuard}; its body is the JSON answer even without the filter. */
export class ConsoleAccessDeniedException extends HttpException {
  constructor(
    readonly decision: Exclude<ConsoleDecision, { allowed: true }>,
    readonly page: boolean,
  ) {
    super(
      decision.reason === 'forbidden'
        ? { error: 'forbidden' }
        : {
            error: 'unauthenticated',
            ...(decision.redirectTo !== undefined ? { redirectTo: decision.redirectTo } : {}),
          },
      decision.reason === 'forbidden' ? 403 : 401,
    );
  }
}

interface HttpRequestLike {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

function isPageNavigation(context: ExecutionContext): boolean {
  const handler = context.getHandler();
  if (Reflect.getMetadata(CONSOLE_PAGE, handler) !== true) return false;
  const req = context.switchToHttp().getRequest<HttpRequestLike>();
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;
  const accept = req.headers?.accept;
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return value.includes('text/html');
}

/**
 * Runs the console's `authorize` on every route of a controller it guards. Applied by the module
 * after the app's `decorators` (so authentication guards have already set `request.user`); a
 * self-mounted controller (`routes: false`) applies it with {@link ConsoleAuthorized}.
 */
@Injectable()
export class ConsoleAuthorizeGuard implements CanActivate {
  constructor(private readonly access: DashboardConsoleAccess) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const decision = await this.access.check(context);
    if (decision.allowed) return true;
    throw new ConsoleAccessDeniedException(decision, isPageNavigation(context));
  }
}

const DENIED_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" ' +
  'content="width=device-width,initial-scale=1"><title>Access denied</title></head>' +
  '<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">' +
  '<main style="text-align:center"><h1>Access denied</h1>' +
  '<p>You are not allowed to open this console.</p></main></body></html>';

/** Writes a console denial: JSON for API calls, HTML or a 302 for page navigations. */
@Catch(ConsoleAccessDeniedException)
@Injectable()
export class ConsoleAccessDeniedFilter implements ExceptionFilter<ConsoleAccessDeniedException> {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: ConsoleAccessDeniedException, host: ArgumentsHost): void {
    const adapter = this.adapterHost.httpAdapter;
    const res = host.switchToHttp().getResponse<unknown>();
    const { decision, page } = exception;
    if (page && decision.reason === 'unauthenticated' && decision.redirectTo !== undefined) {
      adapter.redirect(res, 302, decision.redirectTo);
      return;
    }
    if (page && decision.reason === 'forbidden') {
      adapter.setHeader(res, 'Content-Type', 'text/html; charset=utf-8');
      adapter.reply(res, DENIED_PAGE, 403);
      return;
    }
    adapter.reply(res, exception.getResponse(), exception.getStatus());
  }
}

/**
 * The console's access check on a controller of your own (with `routes: false`): the
 * {@link ConsoleAuthorizeGuard} plus the filter that writes its denials. Put it after your own
 * authentication decorators.
 */
export function ConsoleAuthorized(): ClassDecorator & MethodDecorator {
  return applyDecorators(UseGuards(ConsoleAuthorizeGuard), UseFilters(ConsoleAccessDeniedFilter));
}
