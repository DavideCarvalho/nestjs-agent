import { AGENT_SKILL_SOURCES, type SkillContext } from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { readSkillMetadata, skillScope } from '../decorator/skill.decorator.js';

/**
 * One `@Skill`-decorated provider, reduced to what a `SkillProvider` needs: its catalog line, and a
 * bound function that produces its body for a turn.
 */
export interface DeclaredSkill {
  name: string;
  description: string;
  scope: string;
  body(ctx: SkillContext): string | Promise<string>;
}

/**
 * Collects every `@Skill`-decorated provider into the shared list the module's skill provider reads
 * — the discovery counterpart to authoring skills as rows in the host's own table. Both sources feed
 * one catalog; see `AgentModuleOptions.skills`.
 *
 * A class with neither a flat `body` nor a `body()` method is skipped with a warning rather than
 * offered: a skill the model can see and load, that then returns nothing, reads to it as an
 * instruction to do nothing in particular — which is worse than the skill not existing.
 */
@Injectable()
export class SkillDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(SkillDiscoveryService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(AGENT_SKILL_SOURCES) private readonly declared: DeclaredSkill[],
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (instance === null || typeof instance !== 'object') {
        continue;
      }
      const meta = readSkillMetadata(instance.constructor);
      if (meta === undefined) {
        continue;
      }
      const body = this.bodyOf(instance, meta.body);
      if (body === undefined) {
        this.logger.warn(
          `Skill "${meta.name}" declares no body — add a \`body()\` method or \`@Skill({ body })\`. Skipped.`,
        );
        continue;
      }
      this.declared.push({
        name: meta.name,
        description: meta.description,
        scope: skillScope(meta),
        body,
      });
    }
  }

  /** The instance's `body()` method (bound), else the flat string, else nothing to offer. */
  private bodyOf(
    instance: object,
    flat: string | undefined,
  ): ((ctx: SkillContext) => string | Promise<string>) | undefined {
    const candidate = (instance as { body?: unknown }).body;
    if (typeof candidate === 'function') {
      return (ctx: SkillContext) =>
        (candidate as (ctx: SkillContext) => string | Promise<string>).call(instance, ctx);
    }
    return flat === undefined ? undefined : () => flat;
  }
}
