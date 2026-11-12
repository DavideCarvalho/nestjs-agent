import 'reflect-metadata';
import { AGENT_ACTOR_RESOLVER, AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Global,
  Injectable,
  Logger,
  Module,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentApiController } from './agent-api.controller.js';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import { UseConsoleAuthorize } from './console-authorize.guard.js';
import { CONSOLE_AUTHORIZE_MISSING_WARNING } from './console-authorize.js';

@Policy()
class ConsolePolicy {
  view(user: { roles?: string[] } | null) {
    return user?.roles?.includes('OPS') === true;
  }
}

@Global()
@Module({
  // What a real host's AgentModule and store module bind globally.
  providers: [
    { provide: AGENT_GOVERNANCE_QUERIES, useValue: {} },
    { provide: AGENT_ACTOR_RESOLVER, useValue: { resolve: () => ({ id: 'console' }) } },
  ],
  exports: [AGENT_GOVERNANCE_QUERIES, AGENT_ACTOR_RESOLVER],
})
class HostStoreModule {}

/** The console's API, served from the app's own controller under its own path and @Can(). */
@Controller('ops/ai-gateway/api')
@Can(ConsolePolicy, 'view')
class OwnConsoleApi extends AgentApiController {}

@Module({
  imports: [HostStoreModule, AgentDashboardModule.forRoot({ routes: false })],
  controllers: [OwnConsoleApi],
})
class OwnConsoleModule {}

const getUser = (context: ExecutionContext) => {
  const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
  const id = req.headers['x-user'];
  return id === undefined ? null : { id, roles: [req.headers['x-role'] ?? ''] };
};

@Module({
  imports: [AuthorizationModule.forRoot({ getUser, policies: [ConsolePolicy] }), OwnConsoleModule],
})
class HostRootModule {}

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await close?.();
  close = undefined;
});

describe('AgentDashboardModule({ routes: false }) — the console on controllers of the app’s own', () => {
  it('mounts none of its own routes, and the app’s controller is guarded by its own @Can()', async () => {
    const app = await NestFactory.create(HostRootModule, { logger: false, abortOnError: false });
    await app.init();
    close = () => app.close();
    const server = app.getHttpServer();

    await request(server).get('/ai-gateway/api/spend').expect(404);
    await request(server).get('/ops/ai-gateway/api/spend').expect(401);
    await request(server).get('/ops/ai-gateway/api/spend').set({ 'x-user': 'u1' }).expect(403);
    const allowed = await request(server)
      .get('/ops/ai-gateway/api/spend')
      .set({ 'x-user': 'o1', 'x-role': 'OPS' });
    // Past the app's @Can(): the console's own handling answers (not the 401/403/404 above).
    expect([401, 403, 404]).not.toContain(allowed.status);
  });
});

/** The console's `authorize` on an app-mounted controller, via `UseConsoleAuthorize()`. */
/** Plays the app's authentication guard: `x-user` → `request.user`. */
@Injectable()
class HeaderAuth implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; user?: unknown }>();
    req.user = req.headers['x-user'] ?? null;
    return true;
  }
}

// As documented: UseConsoleAuthorize() above the auth guard, so it runs after it.
@Controller('own/ai-gateway/api')
@UseConsoleAuthorize()
@UseGuards(HeaderAuth)
class AuthorizedConsoleApi extends AgentApiController {}

@Module({
  imports: [
    HostStoreModule,
    AgentDashboardModule.forRoot({
      routes: false,
      authorize: (ctx) => ctx.switchToHttp().getRequest<{ user?: unknown }>().user === 'o1',
    }),
  ],
  controllers: [AuthorizedConsoleApi],
})
class AuthorizedHostModule {}

describe('UseConsoleAuthorize() — the console’s `authorize` on a self-mounted controller', () => {
  it('denies and allows with the module’s `authorize`', async () => {
    const app = await NestFactory.create(AuthorizedHostModule, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
    close = () => app.close();
    const server = app.getHttpServer();

    const denied = await request(server).get('/own/ai-gateway/api/spend').expect(403);
    expect(denied.body).toEqual({ error: 'forbidden' });
    const allowed = await request(server).get('/own/ai-gateway/api/spend').set({ 'x-user': 'o1' });
    expect([401, 403, 404]).not.toContain(allowed.status);
  });
});

describe('AgentDashboardModule({ routes: false }) without `authorize`', () => {
  it('still logs the boot warning once: the exported guard answers 403 in production', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const app = await NestFactory.create(HostRootModule, { logger: false, abortOnError: false });
    await app.init();
    close = () => app.close();
    const calls = warn.mock.calls.filter(([m]) => m === CONSOLE_AUTHORIZE_MISSING_WARNING);
    expect(calls).toHaveLength(1);
  });
});
