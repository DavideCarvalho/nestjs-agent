import 'reflect-metadata';
import { AGENT_ACTOR_RESOLVER, AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import { Controller, type ExecutionContext, Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentApiController } from './agent-api.controller.js';
import { AgentDashboardModule } from './agent-dashboard.module.js';

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
