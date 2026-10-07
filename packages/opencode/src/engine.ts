import type { AgentEngine } from '@dudousxd/nestjs-agent';
import type { InjectionToken, Provider, Type } from '@nestjs/common';
import {
  InMemoryOpenCodeSessionStore,
  type OpenCodeHost,
  type OpenCodeSessionStore,
} from './host.js';
import { OpenCodeAgentRunner } from './runner.js';
import { OPENCODE_HOST, OPENCODE_OPTIONS, OPENCODE_SESSIONS } from './tokens.js';
import { type OpenCodeEngineSettings, OpenCodeTurns } from './turns.js';

export interface OpenCodeEngineOptions extends OpenCodeEngineSettings {
  /**
   * The host: an {@link OpenCodeHost} instance, or a provider class / token resolved from DI (so it
   * can inject the services that know where the server is and how to set sessions up). A class is
   * registered as a provider; a token must be provided by a module the agent module can see.
   */
  host: OpenCodeHost | Type<OpenCodeHost> | InjectionToken;
  /** Where each thread's session is kept. Same forms as `host`. Omit → in memory. */
  sessions?: OpenCodeSessionStore | Type<OpenCodeSessionStore> | InjectionToken;
}

function isInstance<T extends object>(value: unknown, method: keyof T): value is T {
  return typeof value === 'object' && value !== null && typeof (value as T)[method] === 'function';
}

function bind<T extends object>(
  token: symbol,
  value: T | Type<T> | InjectionToken,
  method: keyof T,
): Provider[] {
  if (isInstance<T>(value, method)) return [{ provide: token, useValue: value }];
  if (typeof value === 'function') {
    return [value as Type<T>, { provide: token, useExisting: value }];
  }
  return [{ provide: token, useExisting: value }];
}

/**
 * Run the agent's turns on OpenCode 2 — `AgentModule.forRoot({ engine: openCode({ host }) })`.
 * The routes, threads, stream protocol, approvals and queue stay the library's; OpenCode runs the
 * model, the tools, skills and the context, on the server and sessions the host provides.
 */
export function openCode(options: OpenCodeEngineOptions): AgentEngine {
  return {
    name: 'opencode',
    providers: [...openCodeProviders(options), OpenCodeAgentRunner],
    runner: OpenCodeAgentRunner,
    exports: [OpenCodeTurns],
  };
}

/** The providers every OpenCode engine needs: host, session store, settings and the turn steps. */
export function openCodeProviders(options: OpenCodeEngineOptions): Provider[] {
  const { host, sessions, ...settings } = options;
  return [
    ...bind<OpenCodeHost>(OPENCODE_HOST, host, 'server'),
    ...bind<OpenCodeSessionStore>(
      OPENCODE_SESSIONS,
      sessions ?? new InMemoryOpenCodeSessionStore(),
      'get',
    ),
    { provide: OPENCODE_OPTIONS, useValue: settings },
    OpenCodeTurns,
  ];
}
