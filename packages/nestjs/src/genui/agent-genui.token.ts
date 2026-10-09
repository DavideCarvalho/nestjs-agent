import type {
  Catalog,
  GenuiCatalogScope,
  GenuiChannelBase,
  GenuiChannels,
  SandboxClientConfig,
} from '@dudousxd/nestjs-agent-core/genui';

/**
 * The app's genui setup ({@link AgentGenui}): the catalog, the per-channel options and what the
 * sandbox renderer is told — what the text channels (`@dudousxd/nestjs-agent-channels`) and
 * `GET <base>/config` read.
 */
export const AGENT_GENUI = Symbol.for('@dudousxd/nestjs-agent:genui');

/**
 * The app's genui setup, bound to {@link AGENT_GENUI}: what a text channel draws with
 * (`catalog`, `channels`, `base`) and what the sandbox renderer is told (`sandboxClient`).
 */
export class AgentGenui {
  constructor(
    readonly catalog: Catalog,
    readonly resolveCatalog?: (scope: GenuiCatalogScope) => Catalog | Promise<Catalog>,
    /** `AgentGenuiModule.forRoot({ channels })`, when configured. */
    readonly channels?: GenuiChannels,
    /** The top-level options a channel falls back to. */
    readonly base: GenuiChannelBase = {},
    /** What the sandbox renderer is told, when a sandbox is configured. */
    readonly sandboxClient?: () => SandboxClientConfig,
  ) {}
}
