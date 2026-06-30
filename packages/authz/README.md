# `@dudousxd/nestjs-agent-authz`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · plugs [`@dudousxd/nestjs-authz`](https://www.npmjs.com/package/@dudousxd/nestjs-authz) into [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent) tool authorization.

By default the agent gates tools by **roles**. This adapter gates them by **abilities** through a
`@dudousxd/nestjs-authz` `Gate`: a tool's `ability` is checked with `gate.forUser(actor).allows(ability)`.
Tools without an `ability` fall back to the role-based policy, so apps not using authz are unaffected.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-authz @dudousxd/nestjs-authz
```

## Use

```ts
import { AgentAuthzModule } from '@dudousxd/nestjs-agent-authz';

@Module({
  imports: [
    AuthzModule.forRoot(/* … */),    // the app's global Gate
    AgentModule.forRoot({ model, store, modelId }),
    AgentAuthzModule.forRoot(),       // binds AGENT_ROLES_POLICY to the Gate-backed policy
  ],
})
export class AppModule {}
```

```ts
@AiTool({ name: 'purgeCache', kind: 'action', description: '…', input: z.object({ key: z.string() }),
          ability: 'cache.purge' })   // ← checked via gate.forUser(actor).allows('cache.purge')
export class PurgeCacheTool implements ToolHandler<{ key: string }> { /* … */ }
```

`forRoot({ fallbackRoles })` configures the role policy used when a tool declares no `ability`.

## License

MIT © Davide Carvalho
