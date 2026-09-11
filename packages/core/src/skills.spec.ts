import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_SKILLS,
  GLOBAL_SCOPE,
  type Skill,
  type SkillOffer,
  type SkillSummary,
  actorScope,
  buildSkillsBlock,
  compositeSkillProvider,
  defaultScopeResolver,
  loadSkill,
  offerSkills,
  resolveSkillCatalog,
  skillInputSchema,
  skillToolDefinition,
  skillWriteVerdict,
  staticSkillProvider,
  tenantScope,
  withSkillTool,
} from './skills.js';
import type { Actor, ToolDefinition } from './types.js';

const actor: Actor = { id: 'u1', tenantRef: 'base-7', roles: ['USER'] };

function summary(name: string, scope: string, description = `${name} at ${scope}`): SkillSummary {
  return { name, description, scope };
}

function skill(name: string, scope: string, body: string): Skill {
  return { name, description: `${name} at ${scope}`, scope, body };
}

const SCOPES = [actorScope(actor), 'sector:logistics', tenantScope('base-7'), GLOBAL_SCOPE];

describe('defaultScopeResolver', () => {
  it('resolves actor, tenant and global — most specific first', async () => {
    expect(await defaultScopeResolver.resolve({ actor, threadId: 't1' })).toEqual([
      'actor:u1',
      'tenant:base-7',
      'global',
    ]);
  });

  it('omits the tenant token for an actor with no tenant', async () => {
    expect(await defaultScopeResolver.resolve({ actor: { id: 'u2' }, threadId: 't1' })).toEqual([
      'actor:u2',
      'global',
    ]);
  });
});

describe('resolveSkillCatalog', () => {
  it('lets the most specific scope win and records what it shadowed', () => {
    const { entries } = resolveSkillCatalog(
      [
        summary('normalize-unit', GLOBAL_SCOPE),
        summary('normalize-unit', 'tenant:base-7'),
        summary('normalize-unit', 'sector:logistics'),
      ],
      SCOPES,
    );
    expect(entries).toEqual([
      {
        name: 'normalize-unit',
        description: 'normalize-unit at sector:logistics',
        scope: 'sector:logistics',
        shadows: ['tenant:base-7', 'global'],
      },
    ]);
  });

  it('omits `shadows` entirely when nothing was overridden', () => {
    const { entries } = resolveSkillCatalog([summary('work-order', GLOBAL_SCOPE)], SCOPES);
    expect(entries[0]).not.toHaveProperty('shadows');
  });

  it('drops a skill published at a scope the resolver did not return', () => {
    const { entries } = resolveSkillCatalog(
      [summary('someone-elses', 'actor:u9'), summary('mine', actorScope(actor))],
      SCOPES,
    );
    expect(entries.map((entry) => entry.name)).toEqual(['mine']);
  });

  it('orders most-specific-first, then by name', () => {
    const { entries } = resolveSkillCatalog(
      [
        summary('zulu', actorScope(actor)),
        summary('alpha', GLOBAL_SCOPE),
        summary('bravo', actorScope(actor)),
        summary('charlie', 'tenant:base-7'),
      ],
      SCOPES,
    );
    expect(entries.map((entry) => `${entry.scope}/${entry.name}`)).toEqual([
      'actor:u1/bravo',
      'actor:u1/zulu',
      'tenant:base-7/charlie',
      'global/alpha',
    ]);
  });

  it('trims the WIDEST skills first when over `maxSkills`, and counts what it left out', () => {
    // Named so alphabetical order and scope order disagree: trimming by name would keep the two
    // org defaults and drop the actor's own, which is the wrong half to lose.
    const { entries, omitted } = resolveSkillCatalog(
      [
        summary('aaa-wide', GLOBAL_SCOPE),
        summary('bbb-wide', GLOBAL_SCOPE),
        summary('zzz-mine', actorScope(actor)),
      ],
      SCOPES,
      2,
    );
    expect(entries.map((entry) => entry.name)).toEqual(['zzz-mine', 'aaa-wide']);
    expect(omitted).toBe(1);
  });

  it('reports nothing omitted when everything fits', () => {
    expect(resolveSkillCatalog([summary('one', GLOBAL_SCOPE)], SCOPES).omitted).toBe(0);
  });

  it('defaults its ceiling to DEFAULT_MAX_SKILLS', () => {
    const many = Array.from({ length: DEFAULT_MAX_SKILLS + 3 }, (_, index) =>
      summary(`skill-${String(index).padStart(2, '0')}`, GLOBAL_SCOPE),
    );
    const { entries, omitted } = resolveSkillCatalog(many, SCOPES);
    expect(entries).toHaveLength(DEFAULT_MAX_SKILLS);
    expect(omitted).toBe(3);
  });
});

describe('offerSkills', () => {
  it('asks the provider for exactly the resolved scopes and journals them on the offer', async () => {
    const asked: string[][] = [];
    const offer = await offerSkills(
      {
        provider: {
          list: ({ scopes }) => {
            asked.push([...scopes]);
            return [summary('mine', 'actor:u1')];
          },
          load: () => null,
        },
      },
      { actor, threadId: 't1' },
    );
    expect(asked).toEqual([['actor:u1', 'tenant:base-7', 'global']]);
    expect(offer.scopes).toEqual(['actor:u1', 'tenant:base-7', 'global']);
    expect(offer.entries.map((entry) => entry.name)).toEqual(['mine']);
  });

  it('takes precedence from a host resolver that names an axis this library knows nothing about', async () => {
    const offer = await offerSkills(
      {
        provider: {
          list: () => [
            summary('normalize-unit', 'global'),
            summary('normalize-unit', 'shift:night'),
          ],
          load: () => null,
        },
        scopes: { resolve: () => ['shift:night', 'global'] },
      },
      { actor, threadId: 't1' },
    );
    expect(offer.entries[0]?.scope).toBe('shift:night');
    expect(offer.entries[0]?.shadows).toEqual(['global']);
  });
});

describe('compositeSkillProvider', () => {
  const host = staticSkillProvider([skill('normalize-unit', GLOBAL_SCOPE, 'HOST')]);
  const code = staticSkillProvider([
    skill('normalize-unit', GLOBAL_SCOPE, 'CODE'),
    skill('work-order', GLOBAL_SCOPE, 'CODE'),
  ]);

  it('merges every source, listing each name-at-scope once', async () => {
    const merged = await compositeSkillProvider([host, code]).list({
      scopes: [GLOBAL_SCOPE],
      ctx: { actor, threadId: 't1' },
    });
    expect(merged.map((summary) => summary.name)).toEqual(['normalize-unit', 'work-order']);
  });

  it('lets the earlier source win a name published at the same scope by both', async () => {
    const provider = compositeSkillProvider([host, code]);
    expect(
      await provider.load({
        name: 'normalize-unit',
        scope: GLOBAL_SCOPE,
        ctx: { actor, threadId: 't1' },
      }),
    ).toBe('HOST');
  });

  it('falls through to a later source for a name the earlier one does not have', async () => {
    const provider = compositeSkillProvider([host, code]);
    expect(
      await provider.load({
        name: 'work-order',
        scope: GLOBAL_SCOPE,
        ctx: { actor, threadId: 't1' },
      }),
    ).toBe('CODE');
  });
});

describe('buildSkillsBlock', () => {
  it('lists one line per skill carrying its name, scope and description', () => {
    const block = buildSkillsBlock([
      { name: 'normalize-unit', description: 'Normalise a unit designation.', scope: 'global' },
    ]);
    expect(block).toContain('- normalize-unit [global] — Normalise a unit designation.');
  });

  it('tells the model which scope a skill overrode, so it can say so', () => {
    const block = buildSkillsBlock([
      {
        name: 'normalize-unit',
        description: 'Normalise a unit designation.',
        scope: 'tenant:base-7',
        shadows: ['global'],
      },
    ]);
    expect(block).toContain('(overrides the one from global)');
  });

  it('names the tool the model has to call to read a body', () => {
    expect(buildSkillsBlock([])).toContain('`skill` tool');
  });
});

describe('the skill tool definition', () => {
  it('is offered only when skills are configured', () => {
    const tools: ToolDefinition[] = [];
    expect(withSkillTool({ tools, enabled: false })).toEqual([]);
    expect(withSkillTool({ tools, enabled: true }).map((tool) => tool.name)).toEqual(['skill']);
  });

  it('carries the `skill` kind, so the branch that serves it is settled in the journal', () => {
    expect(skillToolDefinition().kind).toBe('skill');
  });

  it('rejects a call with no name', async () => {
    const result = await skillInputSchema['~standard'].validate({});
    expect(result.issues?.[0]?.message).toBe('must be a non-empty string');
  });

  it('accepts a named call', async () => {
    const result = await skillInputSchema['~standard'].validate({ name: 'normalize-unit' });
    expect(result.issues).toBeUndefined();
    expect((result as { value: { name: string } }).value).toEqual({ name: 'normalize-unit' });
  });
});

describe('loadSkill', () => {
  const provider = staticSkillProvider([
    skill('normalize-unit', 'tenant:base-7', 'Strip the suffix, then match DPAS.'),
    skill('normalize-unit', GLOBAL_SCOPE, 'Match DPAS.'),
    skill('hidden', 'actor:someone-else', 'not yours'),
  ]);

  async function offerFor(scopes: string[]): Promise<SkillOffer> {
    return offerSkills({ provider, scopes: { resolve: () => scopes } }, { actor, threadId: 't1' });
  }

  it('serves the body of the scope that won', async () => {
    const offer = await offerFor(['tenant:base-7', GLOBAL_SCOPE]);
    const outcome = await loadSkill({ provider }, offer, 'normalize-unit', {
      actor,
      threadId: 't1',
    });
    expect(outcome).toEqual({
      ok: true,
      skill: {
        name: 'normalize-unit',
        description: 'normalize-unit at tenant:base-7',
        scope: 'tenant:base-7',
        body: 'Strip the suffix, then match DPAS.',
      },
      shadows: ['global'],
    });
  });

  it('refuses a skill this turn was never offered, whatever the provider holds', async () => {
    const offer = await offerFor([GLOBAL_SCOPE]);
    // A provider that hands back everything it has, scope filter or no scope filter: the catalog
    // the turn was offered is the only thing deciding what the model can reach.
    const leaky = {
      list: () => [
        summary('hidden', 'actor:someone-else'),
        summary('normalize-unit', GLOBAL_SCOPE),
      ],
      load: () => 'not yours',
    };
    const outcome = await loadSkill({ provider: leaky }, offer, 'hidden', {
      actor,
      threadId: 't1',
    });
    expect(outcome).toEqual({
      ok: false,
      error: 'No skill named "hidden" is available to you. Available: normalize-unit.',
    });
  });

  it('refuses a name nobody published', async () => {
    const offer = await offerFor([GLOBAL_SCOPE]);
    const outcome = await loadSkill({ provider }, offer, 'invented', { actor, threadId: 't1' });
    expect(outcome.ok).toBe(false);
  });

  it('reports a listed skill whose body has since gone, rather than pretending it is empty', async () => {
    const offer = await offerFor([GLOBAL_SCOPE]);
    const outcome = await loadSkill(
      { provider: { list: () => [], load: () => null } },
      offer,
      'normalize-unit',
      { actor, threadId: 't1' },
    );
    expect(outcome).toEqual({
      ok: false,
      error: 'Skill "normalize-unit" is listed but its body could not be read.',
    });
  });
});

describe('skillWriteVerdict', () => {
  const scopes = ['actor:u1', 'sector:logistics', 'tenant:base-7', 'global'];

  it('lets a person write their own skill', () => {
    expect(
      skillWriteVerdict({ scope: 'actor:u1', actor, scopes, author: { kind: 'human' } }),
    ).toEqual({ allowed: true });
  });

  it('refuses a scope the actor is not in', () => {
    expect(
      skillWriteVerdict({
        scope: 'tenant:other',
        actor,
        scopes,
        author: { kind: 'human' },
        elevated: true,
      }),
    ).toEqual({
      allowed: false,
      reason: '"tenant:other" is not a scope this actor belongs to',
    });
  });

  it('refuses a person writing above their own scope without the host saying so', () => {
    expect(
      skillWriteVerdict({ scope: 'global', actor, scopes, author: { kind: 'human' } }),
    ).toEqual({
      allowed: false,
      reason: 'authoring at "global" requires an elevated human author',
    });
  });

  it('lets an elevated person write above their own scope', () => {
    expect(
      skillWriteVerdict({
        scope: 'sector:logistics',
        actor,
        scopes,
        author: { kind: 'human' },
        elevated: true,
      }),
    ).toEqual({ allowed: true });
  });

  it('lets an agent write the actor it is running for', () => {
    expect(
      skillWriteVerdict({ scope: 'actor:u1', actor, scopes, author: { kind: 'agent' } }),
    ).toEqual({ allowed: true });
  });

  it('refuses an agent writing above the actor even when the host elevates it', () => {
    expect(
      skillWriteVerdict({
        scope: 'tenant:base-7',
        actor,
        scopes,
        author: { kind: 'agent' },
        elevated: true,
      }),
    ).toEqual({
      allowed: false,
      reason:
        'only a human may author a skill at "tenant:base-7"; an agent may write only at "actor:u1"',
    });
  });
});
