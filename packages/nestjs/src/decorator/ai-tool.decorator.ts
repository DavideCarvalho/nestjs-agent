import 'reflect-metadata';
import type { ToolPresentation } from '@dudousxd/nestjs-agent-core';
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
   * Whether this tool exists in this deployment. `false` — or a predicate returning `false`, which
   * is re-evaluated every turn — drops it before the role filter, so the model is never shown it.
   * Omit → enabled.
   *
   * Use this for availability that is knowable without DI (a constant, `process.env`, a closure
   * over something the app already holds). When the answer lives in an injected service, implement
   * `isEnabled()` on the class instead: this object is built while the decorator is evaluated, at
   * import time, and can't reach the container.
   */
  enabled?: boolean | (() => boolean | Promise<boolean>);
  /**
   * Authz ability checked by an ability-aware RolesPolicy (e.g. `AgentAuthzModule`'s
   * `AuthzRolesPolicy` → `gate.forUser(actor).allows(ability)`). Ignored by the default
   * role-based policy, which uses `roles`.
   */
  ability?: string;
  /**
   * How a chat surface talks about this tool without naming it — sentence templates over the
   * call's input, an icon key, the approval prompt's wording, and how its output reads. Never shown
   * to the model. Served by `GET <base>/tools` to the actors who can reach the tool:
   *
   * ```ts
   * @AiTool({
   *   name: 'purgeCache', kind: 'action', description: '…', input,
   *   presentation: {
   *     label: 'Cache purge', running: 'Purging {key}', done: 'Purged {key}', icon: 'cache',
   *     tone: 'destructive', confirm: { title: 'Purge {key}?', verb: 'Purge' },
   *   },
   * })
   * ```
   */
  presentation?: ToolPresentation;
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
 *
 * A tool the deployment can turn off — the flag read through DI, so `.env` and a config service
 * both work:
 *
 * ```ts
 * @AiTool({ name: 'searchDocs', kind: 'read', description: '...', input: schema })
 * class SearchDocsTool implements ToolHandler<Input> {
 *   constructor(private readonly config: ConfigService) {}
 *   isEnabled() { return this.config.get('DOCS_SEARCH_ENABLED') === 'true'; }
 *   async execute(input, ctx) { ... }
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
