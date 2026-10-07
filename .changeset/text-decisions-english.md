---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
---

**Behavior change:** text decisions on action proposals are now in English by default.
- Approve: `yes`, `confirm`, `approve`, `approved`, `ok`.
- Reject: `no`, `cancel`, `reject`, `deny`.
- Remember the approval: `always in this conversation`.
- The agent's replies are in English too, for example "Proposal approved and queued to run."

The Portuguese commands (`sim`, `aprovar`, `rejeitar`, `sempre nesta conversa`, ...) are no longer recognized unless you opt in.

**To keep Portuguese**, pass the shipped preset. It accepts the Portuguese commands (English still works) and replies in Portuguese:

```ts
import { ptBrActionProposalText } from '@dudousxd/nestjs-agent-core';

AgentModule.forRoot({ /* … */ actionProposalText: ptBrActionProposalText });
```

For any other language, set `actionProposalText: { vocabulary?, replies? }`. Each part you pass replaces the default it names, field by field. Core also exports `DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY`, `DEFAULT_TEXT_ACTION_PROPOSAL_REPLIES` and `textActionProposalReply`, and `resolveTextActionProposalDecision`/`parseTextActionProposalCommand` take an optional vocabulary.
