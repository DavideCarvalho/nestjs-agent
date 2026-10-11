---
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-transport-redis": minor
"@dudousxd/nestjs-agent-testing": minor
---

Poppy (Personal Agent Protocol, experimental) persistence: `DrizzlePoppyStore` / `DrizzlePoppyConnectionStore` and `MikroOrmPoppyStore` / `MikroOrmPoppyConnectionStore`, bound to `AGENT_POPPY_STORE` / `AGENT_POPPY_CONNECTION_STORE` by the store modules on five library-owned, boot-healed tables (`agent_poppy_conversation`, `agent_poppy_event`, `agent_poppy_message`, `agent_poppy_connection`, `agent_poppy_connect`; nothing app-side to migrate); `RedisPoppyStore` / `RedisPoppyConnectionStore` in transport-redis; `POPPY_STORE_CONTRACT` / `POPPY_CONNECTION_STORE_CONTRACT` in testing. On MySQL a connection's issuer is capped at 512 characters (index key length).
