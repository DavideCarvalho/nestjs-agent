---
'@dudousxd/nestjs-agent-testing': patch
---

`CHAT_QUEUE_STORE_CONTRACT` compares the JSON a store hands back (actor, attachments, page context,
queue pause) as values, not as serialized strings. Postgres `jsonb` and MySQL `JSON` return object
keys in their own order, so a store on either failed the contract while round-tripping every field.
