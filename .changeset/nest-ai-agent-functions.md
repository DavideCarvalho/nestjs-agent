---
"@dudousxd/nestjs-agent": minor
---

`@nestjs/ai`'s `@AgentFunction()` methods are agent tools. Every one the application declares is offered to the agent's model and run through `AiTools.call`, so its guards, interceptors, pipes and exception filters apply, with the turn's actor as the call's `user`. `@Govern({ kind, roles, ability, enabled, presentation, terminal })`, stacked on the same method, adds what `@AiTool` declares and `@nestjs/ai` has no word for: an `action` waits for a person's approval, and roles gate who is offered it. `agentFunctions: false` turns this off; `agentFunctionCaller` maps the actor to the call's `scopes`.
