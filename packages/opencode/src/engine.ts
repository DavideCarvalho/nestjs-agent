import type { AgentEngine } from '@dudousxd/nestjs-agent';
import { type InjectionToken, Logger, type Provider, type Type } from '@nestjs/common';
import {
  InMemoryOpenCodeSessionStore,
  type OpenCodeHost,
  type OpenCodeSessionStore,
} from './host.js';
import { OpenCodeMcpController } from './mcp.controller.js';
import { OpenCodeMcpEndpoint, OpenCodeToolsTokens } from './mcp.js';
import { OpenCodeAgentRunner } from './runner.js';
import {
  OPENCODE_HOST,
  OPENCODE_MCP_ENDPOINT,
  OPENCODE_OPTIONS,
  OPENCODE_SESSIONS,
  OPENCODE_TOOLS_TOKENS,
  OPENCODE_TURNS,
} from './tokens.js';
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
    exports: [OpenCodeTurns, OPENCODE_TURNS],
    controllers: openCodeControllers(options),
  };
}

/** The engine's own controllers: the tools endpoint, when `tools` is set. */
export function openCodeControllers(options: OpenCodeEngineSettings): Type<object>[] {
  return options.tools !== undefined ? [OpenCodeMcpController] : [];
}

const DEFAULT_TOOLS_TTL_MS = 7 * 24 * 60 * 60_000;

function toolsTokens(settings: OpenCodeEngineSettings): OpenCodeToolsTokens | null {
  const tools = settings.tools;
  if (tools === undefined) return null;
  if (tools.secret === undefined) {
    new Logger('OpenCodeEngine').warn(
      '`tools` has no `secret`: the tools endpoint signs its tokens with a per-process secret, so it only works with one process (and sessions lose their tools on a restart until their next turn).',
    );
  }
  return new OpenCodeToolsTokens(tools.secret, tools.ttlMs ?? DEFAULT_TOOLS_TTL_MS);
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
    { provide: OPENCODE_TOOLS_TOKENS, useFactory: () => toolsTokens(settings) },
    OpenCodeTurns,
    { provide: OPENCODE_TURNS, useExisting: OpenCodeTurns },
    {
      provide: OPENCODE_MCP_ENDPOINT,
      useFactory: (turns: OpenCodeTurns, tokens: OpenCodeToolsTokens | null) =>
        tokens === null ? null : new OpenCodeMcpEndpoint(turns, tokens),
      inject: [OpenCodeTurns, OPENCODE_TOOLS_TOKENS],
    },
  ];
}
