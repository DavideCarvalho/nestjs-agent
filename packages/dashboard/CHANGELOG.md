# @dudousxd/nestjs-agent-dashboard

## 0.3.1

### Patch Changes

- [`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04) - Governance queries: add `spendByThread(range, limit)` (top threads by cost) and
  `ActorSpendRow.threadCount`. Cost is now priced through the injected
  `AGENT_PRICING_STORE` instead of reading `agent_model_pricing` directly, and both
  store modules accept a `pricingStore` option so a host can bind its own pricing
  table as the single source of cost truth for every governance surface. Default
  behavior (the store's own pricing table) is unchanged.

  The dashboard (`/ai-gateway`) and the Telescope Agent tab gain a "Top threads by
  cost" panel fed by `spendByThread`.
