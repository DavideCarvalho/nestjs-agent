import 'reflect-metadata';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export const AI_TOOL_METADATA = Symbol('nestjs-agent:ai-tool');

export interface AiToolOptions {
  name: string;
  /**
   * `read` auto-executes; `action` requires HITL approval. (Core's `ToolKind` also has `agent`
   * for delegation, but that kind is synthesized from `delegatesTo` — never authored here.)
   */
  kind: 'read' | 'action';
  description: string;
  /**
   * Input schema as a [Standard Schema](https://standardschema.dev) — Zod, Valibot, or ArkType.
   * Validated before the handler runs.
   */
  input: StandardSchemaV1;
  /** Roles allowed to invoke. Omit to inherit the module's default roles. */
  roles?: string[];
  /**
   * Authz ability checked by an ability-aware RolesPolicy (e.g. `AgentAuthzModule`'s
   * `AuthzRolesPolicy` → `gate.forUser(actor).allows(ability)`). Ignored by the default
   * role-based policy, which uses `roles`.
   */
  ability?: string;
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
