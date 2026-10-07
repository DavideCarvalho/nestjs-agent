---
"@dudousxd/nestjs-agent-core": minor
---

Text decisions on action proposals now also recognize English commands: `yes`, `confirm` and `approve` approve; `no`, `cancel` and `reject` reject; `always in this conversation` asks to remember the approval. The Portuguese commands (`sim`, `aprovar`, `rejeitar`, `sempre nesta conversa`, ...) work as before. The match rules are unchanged: the whole message must be the command, with an optional `#ID`.
