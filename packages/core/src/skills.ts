/**
 * Skills: an authored procedure the model pulls in when a task calls for it, instead of every
 * instruction living in the system prompt.
 *
 * WHAT A SKILL IS NOT: an agent. An `@Agent` is WHO is answering — its persona, its tools, its
 * history ceiling, its output schema. A skill is HOW one particular task is done, and any agent may
 * pull one in. That is why a skill carries no model, no tool list and no schema: the moment it did,
 * the two would be the same thing wearing different names, and a consumer would have to choose
 * between them for reasons nobody could state.
 *
 * WHAT IT COSTS THE PROMPT: one line per skill. The catalog block below carries names, scopes and
 * descriptions only; a BODY reaches the model as a tool result, on the transcript, where the
 * `HistoryPolicy` ceiling already governs it. So skills are not a fourth thing competing for the
 * system block with the agent's own prompt, its contributors and injected retrieval — see
 * `AgentLoopDeps.skills` for how the four compose.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Actor, PageContext, ToolDefinition } from './types.js';

/** How a skill is identified in the catalog, to the model and to a `/`-autocomplete alike. */
export interface SkillSummary {
  /** Unique within a scope. The handle the model passes to the `skill` tool. */
  name: string;
  /** One line: what task this covers, and therefore when to load it. Read by the MODEL to choose. */
  description: string;
  /** The opaque scope token this skill is published at — see {@link ScopeResolver}. */
  scope: string;
}

/** A skill with the instructions themselves. Only ever materialized when something loads it. */
export interface Skill extends SkillSummary {
  body: string;
}

/** Whose turn is asking, and therefore which scopes apply. */
export interface ScopeContext {
  actor: Actor;
  threadId: string;
  /** The agent running this turn. Undefined → the default agent. */
  agentName?: string;
  pageContext?: PageContext;
}

/**
 * The skills-facing name for {@link ScopeContext}, so a `SkillProvider`'s signature reads in its own
 * vocabulary. Deliberately the SAME type rather than a parallel one: skills and memory resolve
 * scopes through one `ScopeResolver`, and a deployment that could answer "which scopes does this
 * actor have" twice would eventually answer it differently.
 */
export type SkillContext = ScopeContext;

/** The scope token every deployment has: skills nobody narrowed. */
export const GLOBAL_SCOPE = 'global';

/** The token for one actor's own skills. */
export function actorScope(actor: Actor): string {
  return `actor:${actor.id}`;
}

/** The token for a tenant's skills — `Actor.tenantRef` is the only tenant key this library knows. */
export function tenantScope(tenantRef: string): string {
  return `tenant:${tenantRef}`;
}

/**
 * Which scopes a turn may draw skills from, MOST SPECIFIC FIRST. Precedence is the order: a skill
 * from an earlier token outranks a same-named one from a later token, and the model is shown which
 * of them won.
 *
 * A HOST-SUPPLIED FUNCTION rather than an enum this library owns, because the axes a deployment
 * scopes by are the deployment's own. `Actor` gives an id and a tenant; it does not give a sector, a
 * region, a warehouse, a shift — and every one of those is a real axis in some consumer. An enum here
 * would make each of them a schema change in a library that has no business knowing they exist,
 * while a token is a string a host mints for itself. Return `['sector:logistics', 'tenant:berlin',
 * 'global']` and precedence follows, with nothing in this package edited.
 *
 * MUST be a pure function of its context. It runs inside the `skills:catalog` checkpoint and its
 * result is journaled, so a resumed run reads back the scopes the first attempt resolved rather than
 * asking a membership table that may have changed since — which would otherwise let a run's prompt
 * differ from the one its journal records. Read a database here at your peril; read it in the
 * provider, whose answer is journaled at the same position.
 */
export interface ScopeResolver {
  resolve(ctx: SkillContext): string[] | Promise<string[]>;
}

/**
 * The scopes derivable from an {@link Actor} alone — the common case, so a consumer wiring skills
 * for the first time supplies no resolver at all: the actor's own, their tenant's (when they have
 * one), and the deployment's. A host adding an axis of its own replaces this rather than extending
 * it, since the ORDER is the precedence and only the host knows where its axis belongs.
 */
export const defaultScopeResolver: ScopeResolver = {
  resolve: ({ actor }: SkillContext): string[] => [
    actorScope(actor),
    ...(actor.tenantRef !== undefined ? [tenantScope(actor.tenantRef)] : []),
    GLOBAL_SCOPE,
  ],
};

/**
 * Where skills come from. Deliberately two calls rather than one: `list` is asked on EVERY turn and
 * must stay cheap, while a body is read only when the model decides it needs that procedure — the
 * whole point of the surface. A provider over a table selects name/description/scope for the first
 * and one row for the second.
 *
 * This library owns no skill table. A skill's real scoping axes, its authoring UI and its audit
 * trail are all the host's, and a host that related its own `Sector` entity into a table this
 * package created at boot would be writing migrations against a schema the boot-time heal also
 * edits. Tokens split it the other way round: the library owns the contract (what a scope means, how
 * precedence works, what is journaled), the host owns the rows.
 */
/** Arguments to {@link SkillProvider.list}. */
export interface ListSkillsInput {
  scopes: readonly string[];
  ctx: SkillContext;
}

/**
 * Arguments to {@link SkillProvider.load}. An object rather than positional arguments because
 * `name` and `scope` are both strings: transposed, a positional call compiles clean, returns `null`,
 * and the skill silently fails to load.
 */
export interface LoadSkillInput {
  name: string;
  scope: string;
  ctx: SkillContext;
}

export interface SkillProvider {
  /**
   * Every skill visible at `scopes`, in any order — this library sorts and resolves precedence. A
   * provider MAY return skills outside `scopes`; they are dropped rather than trusted, so a filter
   * bug in a host cannot widen what an actor is offered.
   */
  list(input: ListSkillsInput): SkillSummary[] | Promise<SkillSummary[]>;
  /**
   * The instructions for one skill, or `null` when it is gone. Called only from inside the loading
   * checkpoint, so the body it returns is journaled and every replay reads THAT text back — an
   * edited skill never rewrites the prompt of a run already in flight.
   */
  load(input: LoadSkillInput): string | null | Promise<string | null>;
}

/** A source of skills that is a fixed list — `@Skill()`-decorated classes, or plain config. */
export function staticSkillProvider(skills: readonly Skill[]): SkillProvider {
  return {
    list: ({ scopes }) => skills.filter((skill) => scopes.includes(skill.scope)),
    load: ({ name, scope }) =>
      skills.find((skill) => skill.name === name && skill.scope === scope)?.body ?? null,
  };
}

/**
 * Read several sources as one. The order is the tie-break and nothing else: precedence between
 * skills is by SCOPE, so two sources only ever compete when they publish the same name at the same
 * scope, and then the earlier source wins. Wire the host's own provider first — a row it can edit is
 * a better answer than a body that needs a deploy to change.
 */
export function compositeSkillProvider(providers: readonly SkillProvider[]): SkillProvider {
  return {
    list: async ({ scopes, ctx }) => {
      const seen = new Set<string>();
      const merged: SkillSummary[] = [];
      for (const provider of providers) {
        for (const summary of await provider.list({ scopes, ctx })) {
          const key = `${summary.scope}\u0000${summary.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(summary);
          }
        }
      }
      return merged;
    },
    load: async ({ name, scope, ctx }) => {
      for (const provider of providers) {
        const body = await provider.load({ name, scope, ctx });
        if (body !== null) {
          return body;
        }
      }
      return null;
    },
  };
}

/**
 * One skill as it is offered — to the model in the catalog block, and to a client over
 * `GET /agent/skills`. Both read the same list, built by the same call, so what a user can type
 * after a `/` and what the model can reach cannot drift apart.
 */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** The scope token it resolved from — the provenance a user is entitled to see. */
  scope: string;
  /**
   * Scope tokens of same-named skills this one outranks, widest last. Present ONLY when something
   * was shadowed, so a reader can tell "there is no org default" from "there is one and yours wins".
   * The model is shown it for the same reason: a silent override is indistinguishable from an
   * instruction nobody wrote, and the user can only be told "your setting differs from the org
   * default" by something that knows both existed.
   */
  shadows?: string[];
}

/** What a turn resolved — journaled whole, so the prompt is reconstructible from the journal alone. */
export interface SkillOffer {
  /** The scope tokens this turn drew from, most specific first. */
  scopes: string[];
  /** The skills offered, most specific first then by name. */
  entries: SkillCatalogEntry[];
  /** Applicable skills `maxSkills` left out. Non-zero means the catalog is not the whole truth. */
  omitted: number;
}

/**
 * How many skills a catalog offers before it starts leaving some out. A ceiling on the SYSTEM
 * PROMPT's share, not on how many a deployment may have: the block costs one line each, and a
 * hundred lines of "here is something you could load" crowds out the agent's own instructions while
 * making the choice harder rather than easier.
 */
export const DEFAULT_MAX_SKILLS = 20;

/** How a turn reaches its skills. See `AgentLoopDeps.skills`. */
export interface SkillsConfig {
  provider: SkillProvider;
  /** Undefined → {@link defaultScopeResolver}: the actor's own, their tenant's, the deployment's. */
  scopes?: ScopeResolver;
  /** Undefined → {@link DEFAULT_MAX_SKILLS}. */
  maxSkills?: number;
}

/**
 * Resolve a provider's skills against an ordered scope list: most specific wins, and the loser's
 * scope is recorded rather than discarded.
 *
 * Pure, and separately exported, because two callers must reach the identical answer — the loop, so
 * the model is offered it, and the listing endpoint, so a user is. A second implementation of
 * "which skills apply" is a second answer, and the two diverge the first time either is edited.
 */
export function resolveSkillCatalog(
  summaries: readonly SkillSummary[],
  scopes: readonly string[],
  maxSkills: number = DEFAULT_MAX_SKILLS,
): Omit<SkillOffer, 'scopes'> {
  const rank = new Map(scopes.map((scope, index) => [scope, index]));
  const byName = new Map<string, SkillSummary[]>();
  for (const summary of summaries) {
    // A scope the resolver did not return is one this actor has no claim on, whatever the provider
    // thinks. Dropping it here is what makes over-returning a performance mistake instead of a leak.
    if (!rank.has(summary.scope)) {
      continue;
    }
    const existing = byName.get(summary.name);
    if (existing === undefined) {
      byName.set(summary.name, [summary]);
    } else {
      existing.push(summary);
    }
  }
  const resolved: SkillCatalogEntry[] = [];
  for (const candidates of byName.values()) {
    const ordered = [...candidates].sort(
      (a, b) => (rank.get(a.scope) ?? 0) - (rank.get(b.scope) ?? 0),
    );
    const winner = ordered[0];
    if (winner === undefined) {
      continue;
    }
    const shadows = ordered.slice(1).map((candidate) => candidate.scope);
    resolved.push({
      name: winner.name,
      description: winner.description,
      scope: winner.scope,
      ...(shadows.length > 0 ? { shadows } : {}),
    });
  }
  // Most specific first, then alphabetical: an order a reader can predict, and one where trimming
  // the tail to `maxSkills` drops the WIDEST skills — an org default is the one a deployment can
  // best afford to lose, and the actor's own is the one it can least.
  resolved.sort((a, b) => {
    const byScope = (rank.get(a.scope) ?? 0) - (rank.get(b.scope) ?? 0);
    return byScope !== 0 ? byScope : compare(a.name, b.name);
  });
  return {
    entries: resolved.slice(0, maxSkills),
    omitted: Math.max(0, resolved.length - maxSkills),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Resolve the scopes and the catalog for one turn. Called INSIDE the loop's `skills:catalog` step. */
export async function offerSkills(config: SkillsConfig, ctx: SkillContext): Promise<SkillOffer> {
  const scopes = await (config.scopes ?? defaultScopeResolver).resolve(ctx);
  const summaries = await config.provider.list({ scopes, ctx });
  return { scopes, ...resolveSkillCatalog(summaries, scopes, config.maxSkills) };
}

/**
 * The catalog as the model reads it. One line per skill — name, scope, description, and what it
 * overrides — because the entire claim of progressive disclosure is that choosing what to read costs
 * far less than reading everything.
 */
export function buildSkillsBlock(entries: readonly SkillCatalogEntry[]): string {
  const lines = entries.map((entry) => {
    const shadows =
      entry.shadows === undefined ? '' : ` (overrides the one from ${entry.shadows.join(', ')})`;
    return `- ${entry.name} [${entry.scope}] — ${entry.description}${shadows}`;
  });
  return `<skills>
Procedures available to you. Each line is a name, the scope it came from, and what it covers — not the procedure itself.
Call the \`${SKILL_TOOL_NAME}\` tool with a name from this list to read one BEFORE doing the task it covers, and follow what it says; never guess its contents from the description.
A skill from a narrower scope overrides a same-named one from a wider scope. When you follow one that overrides another, say which scope it came from, so the user knows their setting differs from the wider default.
${lines.join('\n')}
</skills>`;
}

/** The reserved name of the built-in skill-loading tool. */
export const SKILL_TOOL_NAME = 'skill';

/** What the model passes to the `skill` tool. */
export interface SkillToolInput {
  name: string;
}

const SKILL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      description: 'The name of a skill from the <skills> list, exactly as written there.',
    },
  },
} as const;

function issue(path: (string | number)[], message: string) {
  return { message, path };
}

/**
 * The `skill` tool's input schema. Hand-written for the same reason `askInputSchema` is: core
 * depends on no validator and the schema has to publish a JSON Schema a provider can constrain
 * generation against.
 *
 * The available names are deliberately NOT an enum here. A per-turn enum would make the tool's
 * definition depend on the catalog — and the dispatched llm step re-derives the tool list on
 * whichever worker serves it, from ITS OWN provider, which is exactly the process-local lookup this
 * design keeps off the turn's decisions. The names live in the prompt, where the journal holds them;
 * a name that is not in the catalog comes back as an ordinary tool failure listing the ones that are.
 */
export const skillInputSchema = {
  '~standard': {
    version: 1,
    vendor: 'nestjs-agent',
    validate: (value: unknown) => {
      if (typeof value !== 'object' || value === null) {
        return { issues: [issue([], 'must be an object')] };
      }
      const candidate = value as Partial<SkillToolInput>;
      if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
        return { issues: [issue(['name'], 'must be a non-empty string')] };
      }
      return { value: { name: candidate.name } };
    },
    jsonSchema: { input: () => SKILL_JSON_SCHEMA },
  },
} as unknown as StandardSchemaV1<unknown, SkillToolInput>;

export const SKILL_TOOL_DESCRIPTION =
  'Read one of the procedures listed in <skills>. Call it before doing a task a listed skill covers, and follow what it returns. It performs nothing and changes nothing — it only gives you instructions you do not yet have.';

/**
 * The `skill` tool as the model sees it. NOT a `ToolSpec` and never registered, exactly like `ask`:
 * it has no handler, because the loop serves it from the catalog the journal holds. Keeping it out
 * of the `ToolRegistry` is also what keeps its kind off a process-local lookup — see `claimToolCall`.
 */
export function skillToolDefinition(): ToolDefinition {
  return {
    name: SKILL_TOOL_NAME,
    kind: 'skill',
    description: SKILL_TOOL_DESCRIPTION,
    inputSchema: skillInputSchema,
  };
}

/**
 * Append the built-in `skill` definition to a turn's tool list. Exported because the dispatched llm
 * step re-derives the tool list on a worker and has to reach the same list the loop would have.
 */
export function withSkillTool({
  tools,
  enabled,
}: { tools: ToolDefinition[]; enabled: boolean }): ToolDefinition[] {
  return enabled ? [...tools, skillToolDefinition()] : tools;
}

/** What a `skill` call resolved to — the body, or why it did not. */
export type SkillLoadOutcome =
  | { ok: true; skill: Skill; shadows?: string[] }
  | { ok: false; error: string };

/**
 * Serve one `skill` call against the catalog THIS TURN was offered.
 *
 * The catalog is the authorization boundary, not just a menu: a name the turn was never offered is
 * refused here, so a model that invents one (or repeats one it saw in another actor's thread) cannot
 * reach a body through a provider that would happily serve it. Because the catalog came out of the
 * `skills:catalog` checkpoint, that boundary is the one the journal records rather than the one this
 * process's provider currently believes in.
 */
export async function loadSkill(
  config: SkillsConfig,
  offer: SkillOffer,
  name: string,
  ctx: SkillContext,
): Promise<SkillLoadOutcome> {
  const entry = offer.entries.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    const available = offer.entries.map((candidate) => candidate.name).join(', ');
    return {
      ok: false,
      error:
        available.length === 0
          ? `No skill named "${name}" is available to you, and no others are either.`
          : `No skill named "${name}" is available to you. Available: ${available}.`,
    };
  }
  const body = await config.provider.load({ name: entry.name, scope: entry.scope, ctx });
  if (body === null) {
    return { ok: false, error: `Skill "${name}" is listed but its body could not be read.` };
  }
  return {
    ok: true,
    skill: { name: entry.name, description: entry.description, scope: entry.scope, body },
    ...(entry.shadows !== undefined ? { shadows: entry.shadows } : {}),
  };
}

/** Who is trying to write a skill. */
export interface SkillAuthor {
  /**
   * `'human'` is a person acting through a UI; `'agent'` is anything else — a tool, a turn, a
   * batch job. The distinction is the whole of the rule below, so it is not inferable and has to
   * be stated by the caller.
   */
  kind: 'human' | 'agent';
  actorRef?: string;
}

/** A request to author a skill at a scope. */
export interface SkillWriteRequest {
  /** The scope token the skill would be published at. */
  scope: string;
  actor: Actor;
  /** The actor's resolved scopes, most specific first — the same list a turn draws from. */
  scopes: readonly string[];
  author: SkillAuthor;
  /**
   * The host's own answer to "may this person administer that scope" — a sector lead editing their
   * sector's skills, an operator editing the deployment's. This library cannot know it: it has no
   * notion of who administers `sector:logistics`, and inventing one would be a second, weaker
   * authorization model next to the host's real one. Undefined/false → a wider scope is refused.
   */
  elevated?: boolean;
}

export type SkillWriteVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * May this author publish a skill at this scope?
 *
 * A skill's body is instructions the model follows, which makes writing one at a scope an edit to
 * everyone in that scope's system prompt. The rules follow from that, and only the third is
 * interesting:
 *
 * 1. You may only write into a scope you are yourself in. Writing into a scope you are not in is
 *    authoring for people you have no relationship with.
 * 2. Your OWN scope is yours. A per-actor skill affects exactly one prompt — the author's.
 * 3. NOTHING BUT A HUMAN MAY WRITE ABOVE ITS OWN SCOPE, whatever `elevated` says. An agent that can
 *    write a `tenant:` skill is an agent whose prompt anyone in the tenant can edit by talking to
 *    it: the user asks for something, the turn writes the instruction, and every later turn for
 *    every other user follows it. That is prompt injection with persistence, and no elevation a
 *    host could grant makes it a different shape. An agent that has genuinely learned something
 *    worth sharing proposes it; a person publishes it.
 * 4. A human writing above their own scope needs the host to say so (`elevated`).
 */
export function skillWriteVerdict(request: SkillWriteRequest): SkillWriteVerdict {
  const { scope, scopes, author, actor } = request;
  if (!scopes.includes(scope)) {
    return { allowed: false, reason: `"${scope}" is not a scope this actor belongs to` };
  }
  const own = actorScope(actor);
  if (scope === own) {
    return { allowed: true };
  }
  if (author.kind !== 'human') {
    return {
      allowed: false,
      reason: `only a human may author a skill at "${scope}"; an agent may write only at "${own}"`,
    };
  }
  return request.elevated === true
    ? { allowed: true }
    : { allowed: false, reason: `authoring at "${scope}" requires an elevated human author` };
}
