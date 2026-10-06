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

Runs parked on a person live in process memory (like `InlineAgentRunner`). See
`docs/design/2026-10-06-opencode-engine.md` for what is not wired yet.
