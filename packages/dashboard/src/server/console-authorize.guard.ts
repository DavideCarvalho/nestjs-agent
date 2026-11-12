import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type OnModuleInit,
  SetMetadata,
  UseFilters,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import {
  type ConsoleAuthorize,
  type ConsoleDecide,
  type ConsoleDecision,
  resolveConsoleAuthorize,
} from './console-authorize.js';
import { DASHBOARD_CONSOLE_OPTIONS } from './tokens.js';

/** What {@link DashboardConsoleAccess} is built from (bound per `forRoot`). */
export interface DashboardConsoleOptions {
  authorize?: ConsoleAuthorize;
}

/** Holds the console's resolved `authorize` check for one registration. */
@Injectable()
export class DashboardConsoleAccess implements OnModuleInit {
  #decide: ConsoleDecide | undefined;

  constructor(
    @Inject(DASHBOARD_CONSOLE_OPTIONS) private readonly options: DashboardConsoleOptions,
    private readonly moduleRef: ModuleRef,
  ) {}

  #resolving: Promise<ConsoleDecide> | undefined;

  /** Resolves `authorize` at boot: a configuration mistake fails the boot, and the warning logs once. */
  async onModuleInit(): Promise<void> {
    this.#resolving ??= resolveConsoleAuthorize(this.options.authorize, this.moduleRef);
    this.#decide = await this.#resolving;
  }

  /** The decision for one request. */
  async check(context: ExecutionContext): Promise<ConsoleDecision> {
    if (this.#decide === undefined) await this.onModuleInit();
    return (this.#decide as ConsoleDecide)(context);
  }
}

/** Marks a controller or handler as serving pages: a denied browser navigation gets HTML or a 302. */
export const CONSOLE_PAGE_METADATA = '@dudousxd/nestjs-agent-dashboard:console-page';

/**
 * On a controller or a handler that serves pages: a denied `GET` that accepts HTML gets a page (or a
 * 302 for `redirectTo`), not JSON.
 */
export const ConsolePage = (): ClassDecorator & MethodDecorator =>
  SetMetadata(CONSOLE_PAGE_METADATA, true);

/** Thrown by {@link ConsoleAuthorizeGuard}; its body is the JSON answer even without the filter. */
export class ConsoleAccessDenied extends HttpException {
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
  if (context.getType() !== 'http') return false;
  const page =
    Reflect.getMetadata(CONSOLE_PAGE_METADATA, context.getHandler()) === true ||
    Reflect.getMetadata(CONSOLE_PAGE_METADATA, context.getClass()) === true;
  if (!page) return false;
  const req = context.switchToHttp().getRequest<HttpRequestLike>();
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;
  const accept = req.headers?.accept;
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return value.includes('text/html');
}

/**
 * Runs the console's `authorize` on every route of a controller it guards. Applied by the module
 * after the app's `decorators` (so authentication guards have already set `request.user`); a
 * self-mounted controller (`routes: false`) applies it with {@link UseConsoleAuthorize}.
 */
@Injectable()
export class ConsoleAuthorizeGuard implements CanActivate {
  constructor(private readonly access: DashboardConsoleAccess) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const decision = await this.access.check(context);
    if (decision.allowed) return true;
    throw new ConsoleAccessDenied(decision, isPageNavigation(context));
  }
}

/** The minimal page a denied browser navigation gets. */
function deniedPage(title: string, message: string): string {
  const body =
    'font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="${body}"><main style="text-align:center"><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

const FORBIDDEN_PAGE = deniedPage('Access denied', 'You do not have access to this console.');
const UNAUTHENTICATED_PAGE = deniedPage('Sign in required', 'Sign in to open this console.');

/** Writes a console denial: JSON for API calls; a 302 or an HTML page (403 / 401) for page navigations. */
@Catch(ConsoleAccessDenied)
@Injectable()
export class ConsoleAuthorizeFilter implements ExceptionFilter<ConsoleAccessDenied> {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: ConsoleAccessDenied, host: ArgumentsHost): void {
    const adapter = this.adapterHost.httpAdapter;
    const res = host.switchToHttp().getResponse<unknown>();
    const { decision, page } = exception;
    if (page && decision.reason === 'unauthenticated' && decision.redirectTo !== undefined) {
      adapter.redirect(res, 302, decision.redirectTo);
      return;
    }
    if (page) {
      const forbidden = decision.reason === 'forbidden';
      adapter.setHeader(res, 'Content-Type', 'text/html; charset=utf-8');
      adapter.reply(res, forbidden ? FORBIDDEN_PAGE : UNAUTHENTICATED_PAGE, forbidden ? 403 : 401);
      return;
    }
    adapter.reply(res, exception.getResponse(), exception.getStatus());
  }
}

/**
 * The console's access check on a controller of your own (with `routes: false`): the
 * {@link ConsoleAuthorizeGuard} plus the filter that writes its denials. Write it ABOVE your own
 * authentication decorators: class decorators apply bottom-up, so it then runs after them and
 * `request.user` is set.
 */
export function UseConsoleAuthorize(): ClassDecorator & MethodDecorator {
  return applyDecorators(UseGuards(ConsoleAuthorizeGuard), UseFilters(ConsoleAuthorizeFilter));
}
