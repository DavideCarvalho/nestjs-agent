import 'reflect-metadata';
import type { ToolKind } from '@dudousxd/nestjs-agent-core';
import type { ZodType } from 'zod';

export const AI_TOOL_METADATA = Symbol('nestjs-agent:ai-tool');

export interface AiToolOptions {
  name: string;
  kind: ToolKind;
  description: string;
  /** Zod schema for the tool input — validated before the handler runs. */
  input: ZodType;
  /** Roles allowed to invoke. Omit to inherit the module's default roles. */
  roles?: string[];
}

/**
 * Marks a provider class as an AI tool. The class must implement `execute(input, ctx)`.
 * `AiToolDiscoveryService` registers every `@AiTool` provider into the `ToolRegistry` at boot.
 *
 * ```ts
 * @AiTool({ name: 'getWeather', kind: 'read', description: '...', input: z.object({ city: z.string() }) })
 * class GetWeatherTool implements ToolHandler<{ city: string }> {
 *   async execute(input, ctx) { return { tempC: 21 }; }
 * }
 * ```
 */
export function AiTool(options: AiToolOptions): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AI_TOOL_METADATA, options, target);
  };
}

export function readAiToolMetadata(target: object): AiToolOptions | undefined {
  return Reflect.getMetadata(AI_TOOL_METADATA, target.constructor) as AiToolOptions | undefined;
}
