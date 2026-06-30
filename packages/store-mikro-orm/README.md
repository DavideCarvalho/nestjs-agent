# `@dudousxd/nestjs-agent-store-mikro-orm`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · a persistence adapter for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

MikroORM persistence for the agent — threads, messages, tool calls, token usage, and model pricing.
Implements the `AgentStore` SPI and binds it to the `AGENT_STORE` token.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-store-mikro-orm @mikro-orm/core @mikro-orm/nestjs
```

## Use

```ts
import { MikroOrmAgentStoreModule } from '@dudousxd/nestjs-agent-store-mikro-orm';

@Module({
  imports: [
    MikroOrmModule.forRoot(/* your config */),
    MikroOrmAgentStoreModule.forFeature(), // registers the agent entities + binds AGENT_STORE
    AgentModule.forRoot({ /* store comes from AGENT_STORE */ model, modelId, store }),
  ],
})
export class AppModule {}
```

The package ships the entities (`EntitySchema`) and `MikroOrmAgentStore`. Run your normal MikroORM
migrations to create the tables, or use the exported schema helper for a quick start.

## License

MIT © Davide Carvalho
