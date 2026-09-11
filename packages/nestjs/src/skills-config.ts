import {
  type SkillContext,
  type SkillProvider,
  type SkillsConfig,
  compositeSkillProvider,
} from '@dudousxd/nestjs-agent-core';
import type { AgentSkillsOptions } from './agent.options.js';
import type { DeclaredSkill } from './discovery/skill-discovery.service.js';

/**
 * The `@Skill`-decorated classes as a `SkillProvider`. Reads `declared` on every call rather than
 * capturing its contents: DI builds the provider before `SkillDiscoveryService` has filled the list.
 */
export function declaredSkillProvider(declared: readonly DeclaredSkill[]): SkillProvider {
  return {
    list: ({ scopes }) =>
      declared
        .filter((skill) => scopes.includes(skill.scope))
        .map(({ name, description, scope }) => ({ name, description, scope })),
    load: async ({ name, scope, ctx }) => {
      const match = declared.find((skill) => skill.name === name && skill.scope === scope);
      return match === undefined ? null : await match.body(ctx);
    },
  };
}

/**
 * The turn's skills seam, or `undefined` where the host configured none — which is also what keeps
 * a deployment that declares no skills from spending the `skills:catalog` checkpoint.
 *
 * DISCOVERED `@Skill` CLASSES ALONE DO NOT TURN SKILLS ON. Adding a decorated class would otherwise
 * insert a checkpoint into every turn, and a run already in flight when that deployment rolled would
 * replay against a sequence one position short. `skills: {}` is the opt-in; a class discovered
 * without it is reported at boot rather than silently inert.
 */
export function resolveSkillsConfig(
  options: AgentSkillsOptions | undefined,
  declared: readonly DeclaredSkill[],
): SkillsConfig | undefined {
  if (options === undefined) {
    return undefined;
  }
  // The host's own provider first: between two skills of the same name AT THE SAME SCOPE, the one
  // it can edit without a deploy is the better answer. Scope still outranks source for everything
  // else — see `compositeSkillProvider`.
  const providers =
    options.provider === undefined
      ? [declaredSkillProvider(declared)]
      : [options.provider, declaredSkillProvider(declared)];
  return {
    provider:
      providers.length === 1 ? (providers[0] as SkillProvider) : compositeSkillProvider(providers),
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
    ...(options.maxSkills !== undefined ? { maxSkills: options.maxSkills } : {}),
  };
}
