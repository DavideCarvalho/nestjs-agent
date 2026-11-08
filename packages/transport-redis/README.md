# `@dudousxd/nestjs-agent-transport-redis`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · Redis-backed state for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

The default `TokenStreamSink` keeps a run's tokens in the process that started it, so a client that
reconnects to another replica has nothing to replay. `RedisTokenStreamSink` implements the same SPI
over Redis (a list per run for replay, pub/sub for live frames), so any replica can subscribe to any
run's stream. The package also ships Redis stores for the other state that must be shared across
replicas: text channels and Poppy.

The package has no dependency on `ioredis` or `node-redis`. You pass a small client interface that
you implement over the driver you already run.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-transport-redis
```

## Use

```ts
import { AgentModule } from '@dudousxd/nestjs-agent';
import { RedisTokenStreamSink } from '@dudousxd/nestjs-agent-transport-redis';

@Module({
  imports: [
    AgentModule.forRoot({
      // myRedisClient implements RedisStreamClient; options: { keyPrefix?, ttlSeconds? }
      sink: new RedisTokenStreamSink(myRedisClient),
    }),
  ],
})
export class AppModule {}
```

A subscribed Redis connection can't run other commands, so most drivers need a dedicated connection
for `subscribe`. A run's keys expire `ttlSeconds` (default `3600`) after its last write.

## Exports

| Export | What it is |
|---|---|
| `RedisTokenStreamSink` | `TokenStreamSink` over Redis. Takes a `RedisStreamClient`. |
| `RedisChannelStore` | State of text channels shared by every replica. Pass it as `AgentChannelsModule.forRoot({ store })`. |
| `RedisPoppyStore` | Poppy conversation state for `@dudousxd/nestjs-agent-poppy`. |
| `RedisPoppyConnectionStore` | Poppy connection store for `AgentPoppyConnectionsModule`. |

Each class takes a client type (`RedisStreamClient`, `RedisChannelClient`, …) that names the few
commands it uses, and an optional key prefix.

Without Redis, `DrizzleTokenStreamSink` / `MikroOrmTokenStreamSink` from the store packages give the
same multi-replica stream over your database.

Docs: [transport-redis](https://davidecarvalho.github.io/aviary/docs/agent/packages/transport-redis).

## License

MIT © Davide Carvalho
