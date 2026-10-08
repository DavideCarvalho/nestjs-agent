# @dudousxd/nestjs-agent-channels

The agent on text channels — WhatsApp ([Evolution API](https://doc.evolution-api.com) or Meta's
Cloud API) and Telegram — for [`@dudousxd/nestjs-agent`](../nestjs). One webhook route per channel
that verifies the request, deduplicates by the provider's message id, answers `200` at once and runs
the turn in the background; the reply is converted to the channel's markdown and split at its length
limit. Pending proposals arrive as Confirm/Cancel buttons (or a text instruction), questions as
numbered text, media as staged attachments, and late outcomes are relayed when the proposal worker
settles them.

When the agent runs durably (`durable: true` with `AgentDurableModule`), each message is a
`@dudousxd/nestjs-durable` run: persisted before the `200`, handled one at a time per conversation,
retried, and resumed after a crash without answering twice. Text decisions only decide cards
delivered to that conversation, and hooks (`unknownSender`, `beforeTurn`, `canDeliver`, per-message
`texts`, `renderComponent`, `prepareMedia`, `transformInbound`, `formatOutcome`, `onTurnStarted`,
`onWebhook`) cover the app's own flows.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-channels @dudousxd/nestjs-agent @dudousxd/nestjs-agent-core
```

## Mount it

```ts
// main.ts — WhatsApp Cloud signs the raw body
const app = await NestFactory.create(AppModule, { rawBody: true });

// app.module.ts
import { AgentModule } from '@dudousxd/nestjs-agent';
import { AgentChannelsModule, telegram } from '@dudousxd/nestjs-agent-channels';

@Module({
  imports: [
    AgentModule.forRoot({ /* … */ actionApprovalMode: 'independent' }),
    AgentChannelsModule.forRoot({
      channels: [
        {
          adapter: telegram({ botToken: process.env.TELEGRAM_BOT_TOKEN, secretToken: process.env.TELEGRAM_SECRET }),
          actor: (message) => accounts.forTelegram(message.from), // null → not answered
          thread: (actor, message) => threads.get(message.conversation), // null → a new thread
          onThreadCreated: (threadId, actor, message) => threads.set(message.conversation, threadId),
        },
      ],
    }),
  ],
})
export class AppModule {}
// POST /channels/telegram
```

Adapters: `evolutionApi({ url, instance, apiKey, webhookToken })`, `whatsmiau({ url, instance,
apiKey, webhookToken })` (Evolution-compatible, buttons on), `whatsappCloud({ phoneNumberId,
accessToken, appSecret, verifyToken })`, `telegram({ botToken, secretToken })`, or any
`ChannelAdapter`. The channels' state (message ids, questions in progress, relayed outcomes) lives in
the `ChannelStore` bound to `AGENT_CHANNEL_STORE` — the Drizzle and MikroORM store modules bind one on
`agent_channel_state` — else in memory; `RedisChannelStore` (`@dudousxd/nestjs-agent-transport-redis`)
or your own plugs in through `store`.

Full guide: [Text channels](https://davidecarvalho.github.io/aviary/docs/agent/guides/channels).
