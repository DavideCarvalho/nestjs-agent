import 'reflect-metadata';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { GUARDS_METADATA as REAL_GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { AgentApiController } from './agent-api.controller.js';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import { AgentUiController } from './agent-ui.controller.js';

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
  it('stamps the given guards on BOTH controllers (REPLACE semantics)', () => {
    AgentDashboardModule.forRoot({ guards: [FakeGuard] });

    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, AgentApiController)).toEqual([FakeGuard]);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, AgentUiController)).toEqual([FakeGuard]);
  });

  it('a later forRoot() with no guards clears (not appends to) a prior stamp', () => {
    AgentDashboardModule.forRoot({ guards: [FakeGuard] });
    AgentDashboardModule.forRoot();

    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, AgentApiController)).toEqual([]);
    expect(Reflect.getMetadata(REAL_GUARDS_METADATA, AgentUiController)).toEqual([]);
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
});
