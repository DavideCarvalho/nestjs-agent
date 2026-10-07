---
"@dudousxd/nestjs-agent-store-drizzle": minor
---

Independent approvals now work on Drizzle over postgres.js (`drizzle-orm/postgres-js`, `PostgresJsDatabase`). Its transactions are awaited like node-postgres's, so it is now on the certified list. The proposal, outcome-admission, transaction-race and chat-queue database suites now also run on postgres.js.
