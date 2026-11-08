import 'reflect-metadata';
import { AGENT_ACTOR_RESOLVER, AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import { type CanActivate, Global, Injectable, Module, UseGuards } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentApiController } from './agent-api.controller.js';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import { AgentUiController } from './agent-ui.controller.js';

@Injectable()
class DenyAll implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

/** What a real host's AgentModule and store module bind globally. */
@Global()
@Module({
  providers: [
    { provide: AGENT_GOVERNANCE_QUERIES, useValue: {} },
    { provide: AGENT_ACTOR_RESOLVER, useValue: { resolve: () => ({ id: 'console' }) } },
  ],
  exports: [AGENT_GOVERNANCE_QUERIES, AGENT_ACTOR_RESOLVER],
})
class HostStoreModule {}

const previousEnv = process.env.NODE_ENV;
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  process.env.NODE_ENV = previousEnv;
  await close?.();
  close = undefined;
});

async function boot(dashboard: ReturnType<typeof AgentDashboardModule.forRoot>) {
  @Module({ imports: [HostStoreModule, dashboard] })
  class HostRootModule {}
  const app = await NestFactory.create(HostRootModule, { logger: false, abortOnError: false });
  await app.init();
  close = () => app.close();
  return app.getHttpServer();
}

describe('AgentDashboardModule — who reaches the console', () => {
  it('refuses to serve it open in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => AgentDashboardModule.forRoot()).toThrow(/served open in production/);
    expect(() => AgentDashboardModule.forRoot({ decorators: [] })).toThrow(
      /served open in production/,
    );
  });

  it('serves it in production once decorators say who reaches it, or when the app mounts it', () => {
    process.env.NODE_ENV = 'production';
    expect(() => AgentDashboardModule.forRoot({ decorators: [UseGuards(DenyAll)] })).not.toThrow();
    expect(() => AgentDashboardModule.forRoot({ routes: false })).not.toThrow();
  });

  it('applies decorators to the mounted routes, and never to the shared controller classes', async () => {
    const server = await boot(AgentDashboardModule.forRoot({ decorators: [UseGuards(DenyAll)] }));
    await request(server).get('/ai-gateway/api/spend').expect(403);
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentApiController) ?? []).toEqual([]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentUiController) ?? []).toEqual([]);
  });

  it('mounts the console open outside production when nothing is said', async () => {
    const server = await boot(AgentDashboardModule.forRoot());
    const res = await request(server).get('/ai-gateway/api/spend');
    expect([401, 403, 404]).not.toContain(res.status);
  });
});
