import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { AiToolCtx, ToolHandler } from './spi/tool.js';
import {
  canActorUseTool,
  filterToolsByAllowList,
  filterToolsByCanUse,
  filterToolsByEnabled,
  filterToolsByRole,
  isToolEnabled,
} from './tool-filters.js';
import type { Actor, ToolDefinition, ToolSpec } from './types.js';

/** Thrown when an actor invokes a tool their role is not allowed. */
export class ToolForbiddenError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" is not allowed for this role`);
    this.name = 'ToolForbiddenError';
  }
}

/**
 * Thrown when a registered tool is invoked while this deployment has it turned off (`enabled` /
 * `isEnabled()`). Distinct from {@link ToolForbiddenError}, which is about the actor, and from
 * {@link ToolNotFoundError}, which is about a name nobody registered — an operator reading a log
 * needs to tell "you flipped the flag" apart from "that tool does not exist in this build".
 *
 * Reachable in normal operation, not just from a forged call: a HITL `action` approved before the
 * flag was turned off runs its tool afterwards.
 */
export class ToolDisabledError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" is disabled in this deployment`);
    this.name = 'ToolDisabledError';
  }
}

/** Thrown when a tool is invoked that was never registered. */
export class ToolNotFoundError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" is not registered`);
    this.name = 'ToolNotFoundError';
  }
}

/** Thrown when a tool's input fails its Standard Schema validation. */
export class ToolInputInvalidError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly issues: readonly StandardSchemaV1.Issue[],
  ) {
    super(
      `Invalid input for tool "${toolName}": ${issues.map((issue) => issue.message).join('; ')}`,
    );
    this.name = 'ToolInputInvalidError';
  }
}

interface Entry {
  spec: ToolSpec;
  handler: ToolHandler;
}

/**
 * Holds every registered tool and gates invocation.
 *
 * Note: `definitionsFor` returns NEUTRAL definitions (no `execute`). The agent loop runs
 * each tool itself as a (durable) step — so even read tools are not auto-executed by the
 * model. `action` tools additionally require HITL approval before the loop runs them.
 */
export class ToolRegistry {
  private readonly entries = new Map<string, Entry>();

  register(spec: ToolSpec, handler: ToolHandler): void {
    this.entries.set(spec.name, { spec, handler });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  spec(name: string): ToolSpec | undefined {
    return this.entries.get(name)?.spec;
  }

  allSpecs(): ToolSpec[] {
    return [...this.entries.values()].map((entry) => entry.spec);
  }

  /**
   * The tools to offer the model for this actor+agent, after the four filter layers: what this
   * deployment has enabled, what this actor's role allows, what each tool's own `canUse` allows
   * this actor, and finally what this agent pinned.
   *
   * Every layer only ever removes tools, so no arrangement of them can widen what a turn reaches.
   */
  async definitionsFor(
    actor: Actor,
    policy: RolesPolicy,
    allowedTools?: string[],
  ): Promise<ToolDefinition[]> {
    const live = await filterToolsByEnabled([...this.entries.values()]);
    const allowedByRole = new Set(
      (
        await filterToolsByRole(
          live.map((entry) => entry.spec),
          actor,
          policy,
        )
      ).map((spec) => spec.name),
    );
    const roleScoped = live.filter((entry) => allowedByRole.has(entry.spec.name));
    const actorScoped = await filterToolsByCanUse(roleScoped, actor);
    const allowScoped = filterToolsByAllowList(
      actorScoped.map((entry) => entry.spec),
      allowedTools,
    );
    return allowScoped.map((spec) => ({
      name: spec.name,
      kind: spec.kind,
      description: spec.description,
      inputSchema: spec.inputSchema,
    }));
  }

  /**
   * Run a tool. Re-checks that the tool is enabled and that the role allows it (defense-in-depth —
   * a call can reach here from a replayed durable step or an approval granted before the flag
   * moved, neither of which went through `definitionsFor` again) and re-parses the input via Zod.
   */
  async invoke(
    name: string,
    input: unknown,
    ctx: AiToolCtx,
    policy: RolesPolicy,
  ): Promise<unknown> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new ToolNotFoundError(name);
    }
    if (!(await isToolEnabled(entry.spec, entry.handler))) {
      throw new ToolDisabledError(name);
    }
    if (!(await policy.can(ctx.actor, entry.spec))) {
      throw new ToolForbiddenError(name);
    }
    if (!(await canActorUseTool(ctx.actor, entry.handler))) {
      throw new ToolForbiddenError(name);
    }
    const validation = await entry.spec.inputSchema['~standard'].validate(input);
    if (validation.issues !== undefined) {
      throw new ToolInputInvalidError(name, validation.issues);
    }
    return entry.handler.execute(validation.value, ctx);
  }
}

/** Default gate: one of the actor's roles must be in spec.roles (defaulting to ADMIN-only). */
export class DefaultRolesPolicy implements RolesPolicy {
  constructor(private readonly defaultRoles: string[] = ['ADMIN']) {}

  can(actor: Actor, tool: ToolSpec): boolean {
    const allowed = tool.roles ?? this.defaultRoles;
    return (actor.roles ?? []).some((role) => allowed.includes(role));
  }
}
