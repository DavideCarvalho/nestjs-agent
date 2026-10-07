# @dudousxd/nestjs-agent-opencode

Run `@dudousxd/nestjs-agent` turns on [OpenCode 2](https://opencode.ai). The library keeps the
routes, threads, stream protocol, approvals, questions and queue (so `@dudousxd/nestjs-agent-react`
works unchanged); OpenCode runs the model, the tools, skills and the context.

```ts
import { AgentModule } from '@dudousxd/nestjs-agent';
import { openCode, type OpenCodeHost } from '@dudousxd/nestjs-agent-opencode';

@Injectable()
class MyOpenCodeHost implements OpenCodeHost {
  constructor(private readonly sandboxes: SandboxService) {}

  /** Which OpenCode server runs this actor's turns. */
  async server(actor: Actor) {
    const rt = await this.sandboxes.runtimeFor(actor.tenantId);
    return { client: rt.client, key: actor.tenantId, bootId: rt.bootId };
  }

  /** How a thread's session is created (only when it has none on this server). */
  async session({ input }: OpenCodeTurnContext) {
    return {
      location: { directory: `/work/${input.actor.id}` },
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'execute', resource: '*', effect: 'allow' },
        { action: 'company.*send*', resource: '*', effect: 'ask' }, // → approval card
        { action: 'question', resource: '*', effect: 'allow' },     // → elicitation form
      ],
    };
  }

  /** Extra instructions entries, refreshed every turn. */
  async instructions({ input }: OpenCodeTurnContext) {
    return { 'app.profile': await this.profiles.describe(input.actor) };
  }
}

@Module({
  imports: [
    AgentModule.forRoot({
      engine: openCode({ host: MyOpenCodeHost }),
      store, // any AgentStore
      actorResolver,
    }),
  ],
  providers: [MyAgent], // @Agent({ systemPrompt }) / @SystemPrompt() → instructions `aviary.system`
})
export class AppModule {}
```

| OpenCode | The library's protocol and store |
| --- | --- |
| `session.text.delta` / `session.reasoning.delta` | `text` / `reasoning` |
| a step (`session.step.ended`) | `step-start` … `step-finish` with usage; usage recorded per step |
| tools (`session.tool.*`) | `tool-input-*` / `tool-output*`, code-mode inner calls nested by `parentId` |
| `permission.asked` | an `action` call + `approval-requested`, recorded `pending_approval`; `approve` / `reject` → `permission.reply` |
| `form.created` | `elicitation`; `answer` / `skip` → `session.form.reply` / `cancel` |
| `session.renamed` | `title` |
| `session.execution.*` | the run settles: queue handoff, `cancelled`, or a typed stream failure |
| `cancel` | `session.interrupt` |

Sessions: one per thread, kept by an `OpenCodeSessionStore` (in memory by default; persist it for
several replicas) and recreated when the server's `bootId` changes, told the conversation so far.

## Durable turns

```ts
import { openCodeDurable } from '@dudousxd/nestjs-agent-opencode/durable';

AgentModule.forRoot({ engine: openCodeDurable({ host: MyOpenCodeHost, sessions: MySessionStore }), store, sink, actorResolver })
// next to a configured DurableModule
```

Every step of a turn is checkpointed (`begin → prompt → observe → [wait for a person → reply →
observe]* → finish`) and a person's decision is a durable signal: a turn waiting on an approval
survives restarts and is resumed by whichever process gets the decision. If OpenCode restarted
meanwhile, a new session is opened with the conversation and the decision. `openCode()` runs the
same steps in memory (single replica). Several processes need a cross-process sink and a persistent
`OpenCodeSessionStore`.

## What the session gets from the module

| Option | In the session |
| --- | --- |
| `@Agent` / `@SystemPrompt` / contributors | instructions `aviary.system`, refreshed every turn |
| `approvalPolicy` | who approves each `permission.asked`, and its expiry; not required → answered at once |
| `tools: { url, headers }` | the module's `@AiTool`s over MCP (`AgentMcpServerModule` with `actions: 'execute'`): reads allowed, actions asked |
| `skills` / `@Skill` | `.opencode/skills/<name>/SKILL.md` in the session's directory |
| `memory` | instructions `aviary.memory`; with `tools`, a `remember` tool when the provider writes |
| `ctx.emitUi` in a tool | the component lands in the turn's stream and message (see below) |
| `regenerate` | the session is reverted to before the last user message |

## Tools over MCP

```ts
AgentModule.forRoot({
  engine: openCode({
    host: MyOpenCodeHost,
    tools: { url: 'https://app.internal/mcp', headers: (actor) => ({ Authorization: `Bearer ${mint(actor)}` }) },
  }),
  memory: { provider }, // a provider with `write` → OpenCode gets `remember`
  ...
}),
AgentMcpServerModule.forRootAsync({
  inject: [OpenCodeTurns],
  useFactory: (turns: OpenCodeTurns) => ({
    name: 'app', version: '1', auth: myBearerResolver,
    actions: 'execute', // OpenCode's `ask` rules put the person in front of action tools
    context: (input) => turns.toolContext(input), // ties each call to its turn (`_meta`)
  }),
}),
```

## Several processes

Use `openCodeDurable()`, a cross-process sink, and a shared session store:
`sessions: keyValueOpenCodeSessionStore(redis)`.

## Testing against a real OpenCode

```sh
OPENCODE_LIVE_URL=http://127.0.0.1:4096 OPENCODE_LIVE_PASSWORD=… \
OPENCODE_LIVE_MODEL=opencode-go/longcat-2.5-preview-free OPENCODE_LIVE_DIR=/tmp/work \
pnpm vitest run packages/opencode/src/live
```

The server (`opencode serve`, 2.x, `OPENCODE_SERVER_PASSWORD` set) needs a key for the model's
provider (`integration.connect.key`). Without `OPENCODE_LIVE_URL` the live specs are skipped.

See `docs/design/2026-10-06-opencode-engine.md` for what is not wired yet.
