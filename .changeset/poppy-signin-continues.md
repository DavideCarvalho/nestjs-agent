---
'@dudousxd/nestjs-agent-poppy': patch
---

A Poppy conversation started signed out now continues after the User signs in. The step-up turn used to fail with `thread belongs to another actor` (the thread belonged to the signed-out `poppy:<hash>` actor, the turn ran as the account) and the personal agent got "Sorry, something went wrong". When the thread's owner is not the turn's actor, the turn runs in a new thread, told the conversation's earlier messages as a transcript. `PersonalAgentTurnService` may implement `threadOwner` (`AgentService` does).
