import 'reflect-metadata';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { GUARDS_METADATA as REAL_GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { AgentApiController } from './agent-api.controller.js';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import { AgentUiController } from './agent-ui.controller.js';
import { DashboardAuthPageGuard } from './auth/dashboard-auth-page.guard.js';
import { DashboardAuthGuard } from './auth/dashboard-auth.guard.js';

/** The literal `agent-dashboard.module.ts` inlines instead of deep-importing '@nestjs/common/constants'. */
const INLINED_GUARDS_METADATA = '__guards__';

@Injectable()
class FakeGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

describe('GUARDS_METADATA drift', () => {
  it("stays byte-identical to @nestjs/common's real GUARDS_METADATA constant", () => {
    expect(INLINED_GUARDS_METADATA).toBe(REAL_GUARDS_METADATA);
  });
});

describe('AgentDashboardModule.forRoot guards', () => {
  it('appends the given guards onto the built-in dashboardAuth baseline (never replacing it)', () => {
    AgentDashboardModule.forRoot({ guards: [FakeGuard] });

    // Baseline is each controller's OWN `@UseGuards` decorator — the built-in, always-present
    // (no-op unless `dashboardAuth` is set) session gate — with the host's `guards` appended.
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, AgentApiController)).toEqual([
      DashboardAuthGuard,
      FakeGuard,
    ]);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, AgentUiController)).toEqual([
      DashboardAuthPageGuard,
      FakeGuard,
    ]);
  });

  it('a later forRoot() with no guards resets to just the built-in baseline (not a stale prior stamp)', () => {
    AgentDashboardModule.forRoot({ guards: [FakeGuard] });
    AgentDashboardModule.forRoot();

    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, AgentApiController)).toEqual([
      DashboardAuthGuard,
    ]);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, AgentUiController)).toEqual([
      DashboardAuthPageGuard,
    ]);
  });

  it('passes an `imports` passthrough into the dynamic module for guard-dependency resolution', () => {
    class FakeAuthModule {}

    const dynamicModule = AgentDashboardModule.forRoot({
      guards: [FakeGuard],
      imports: [FakeAuthModule],
    });

    expect(dynamicModule.imports).toContain(FakeAuthModule);
  });

  it('omitting `imports` still returns a valid dynamic module', () => {
    const dynamicModule = AgentDashboardModule.forRoot();
    expect(dynamicModule.imports?.length).toBeGreaterThan(0);
  });

  it('accepts a request-typed approvalActorRef via the TReq generic (no unknown-narrowing needed)', () => {
    interface ConsoleRequest {
      user?: { id: string };
    }
    // The point is the compile: `req` arrives as ConsoleRequest, so the extractor reads its
    // principal directly — mirroring core's ActorResolver<TReq> convention.
    const dynamicModule = AgentDashboardModule.forRoot<ConsoleRequest>({
      approvalActorRef: (req) => req.user?.id,
    });
    expect(dynamicModule.module).toBe(AgentDashboardModule);
  });
});

describe('guard DI resolution in the API controller host module', () => {
  // Regression: guards are DI-instantiated by the CONTROLLER's host module. AgentApiController
  // lives in AgentApiModule, which used to be a static module receiving neither the guard
  // providers nor the host's `imports` — a guard WITH dependencies booted fine in tests using
  // dependency-less guards, then failed real hosts with "Nest can't resolve dependencies of the
  // <Guard> ... in the AgentApiModule context".
  it('threads guards + host imports into the API module so a guard with deps resolves', async () => {
    const {
      Inject,
      Module: ModuleDecorator,
      Injectable: InjectableDecorator,
      Global: GlobalDecorator,
    } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { AGENT_GOVERNANCE_QUERIES } = await import('@dudousxd/nestjs-agent-core');

    @InjectableDecorator()
    class AuthService {
      allowed(): boolean {
        return false;
      }
    }

    @ModuleDecorator({ providers: [AuthService], exports: [AuthService] })
    class HostAuthModule {}

    @InjectableDecorator()
    class GuardWithDeps implements CanActivate {
      constructor(@Inject(AuthService) private readonly auth: AuthService) {}
      canActivate(_context: ExecutionContext): boolean {
        return this.auth.allowed();
      }
    }

    // Real hosts bind the governance/pricing tokens via a @Global store module; mirror that so
    // DashboardService (inside AgentApiModule) resolves them across the module boundary.
    @GlobalDecorator()
    @ModuleDecorator({
      providers: [{ provide: AGENT_GOVERNANCE_QUERIES, useValue: {} }],
      exports: [AGENT_GOVERNANCE_QUERIES],
    })
    class HostStoreModule {}

    @ModuleDecorator({
      imports: [
        HostStoreModule,
        AgentDashboardModule.forRoot({ guards: [GuardWithDeps], imports: [HostAuthModule] }),
      ],
    })
    class HostRootModule {}

    // Boot proves the wiring: guard instantiation happens per controller HOST module, so init
    // throws "Nest can't resolve dependencies ... in the AgentApiModule context" if the guard
    // providers/imports did not land there (the regressed behavior).
    const app = await NestFactory.create(HostRootModule, { logger: false, abortOnError: false });
    await app.init();
    await app.close();
  });
});
