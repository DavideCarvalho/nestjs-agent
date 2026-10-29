---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-testing": minor
---

Fork a thread into another actor's copy — "continue this conversation" from a shared link: the reader
gets their own copy up to that message, and the original stays its owner's.

`AgentStore.forkThread(threadId, fromMessageId, options?: ForkThreadOptions)` takes
`{ actorRef?, tenantRef? }`. `actorRef` makes the copy that actor's; `tenantRef` is separate — absent
keeps the source's tenant even with a new `actorRef`, `null` clears it, a value sets it. Without
options nothing changes. `InMemoryAgentStore`, `DrizzleAgentStore` and `MikroOrmAgentStore` implement
it, and `FORK_THREAD_CONTRACT` in the testing package checks a store does.

`AgentService.forkThread(actor, threadId, fromMessageId, params?: ForkThreadParams)` takes
`{ authorized?, tenantRef? }`. With `authorized: true` the host vouches that `actor` may read the
thread: the ownership check is skipped and the copy is `actor`'s. It stays owner-only by default, and
`POST /threads/:id/fork-from/:messageId` never passes it.
