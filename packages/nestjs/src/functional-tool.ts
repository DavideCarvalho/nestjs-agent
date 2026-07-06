import type { ToolHandler, ToolSpec } from '@dudousxd/nestjs-agent-core';
import type { FactoryProvider, Provider } from '@nestjs/common';

/**
 * Brand stamped onto a functional-tool provider instance so `AiToolDiscoveryService` picks it up
 * when it walks every provider at boot — the declarative alternative to a manual `registry.register`.
 */
export const AGENT_TOOL_BRAND = Symbol.for('@dudousxd/nestjs-agent:functional-tool');

/** A tool expressed as data + handler (e.g. from `createExecuteSqlTool`), not an `@AiTool` class. */
export interface FunctionalTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

/** A {@link FunctionalTool} carrying {@link AGENT_TOOL_BRAND} — what a provider resolves to. */
export interface BrandedFunctionalTool extends FunctionalTool {
  readonly [AGENT_TOOL_BRAND]: true;
}

function brand(tool: FunctionalTool): BrandedFunctionalTool {
  return { [AGENT_TOOL_BRAND]: true, spec: tool.spec, handler: tool.handler };
}

/** Narrows a provider instance to a branded functional tool for boot-time registration. */
export function isBrandedFunctionalTool(value: object): value is BrandedFunctionalTool {
  return AGENT_TOOL_BRAND in value && 'spec' in value && 'handler' in value;
}

/**
 * Registers a functional tool declaratively — drop the returned provider in a module's `providers`
 * and `AiToolDiscoveryService` auto-registers it at boot. Each call uses a fresh, unique provide
 * token so the same tool can be provided many times without collisions.
 *
 * Two forms: a static tool (`useValue`) or a factory with `inject` for DI-resolved dependencies
 * (`useFactory`). Either way the resolved instance is branded with {@link AGENT_TOOL_BRAND}.
 */
export function provideAgentTool(tool: FunctionalTool): Provider;
export function provideAgentTool(
  factory: (...deps: never[]) => FunctionalTool,
  inject?: FactoryProvider['inject'],
): Provider;
export function provideAgentTool(
  factoryOrTool: FunctionalTool | ((...deps: never[]) => FunctionalTool),
  inject?: FactoryProvider['inject'],
): Provider {
  const provide = Symbol('nestjs-agent:functional-tool-instance');
  if (typeof factoryOrTool === 'function') {
    return {
      provide,
      useFactory: (...deps: never[]) => brand(factoryOrTool(...deps)),
      inject: inject ?? [],
    };
  }
  return { provide, useValue: brand(factoryOrTool) };
}
