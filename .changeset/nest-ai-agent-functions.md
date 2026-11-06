---
"@dudousxd/nestjs-agent": minor
---

The agent's tools are `@nestjs/ai` agent functions, and `@nestjs/ai`'s agent functions are the agent's tools.

- **`@AiTool` registers an `@AgentFunction()`** on its `execute()` (when its input schema produces JSON Schema, as Zod 4's does). With `AiModule` imported, the agent's calls go through `AiTools.call`, so the guards, interceptors and pipes the class and `execute()` declare run around them — `execute()` still receives the turn's own `AiToolCtx`, and the agent still persists, presents and classifies what it returned or threw, not `@nestjs/ai`'s JSON of it. `@nestjs/ai`'s own calls (`AiService.generateText({ tools: ['getWeather'] })`) can offer it too: there, outside any turn, an `action` is refused (only a turn asks a person) and the tool's `roles` are checked against the call's `user`.
- **`@nestjs/ai`'s `@AgentFunction()` methods are offered to the agent**, run through `AiTools.call`, as `read` tools under the policy's default roles. This library's own **`@AgentFunction()`** is `@nestjs/ai`'s with the agent's governance in the same options — `kind` (`action` waits for a person's approval), `roles`, `ability`, `enabled`, `presentation`, `terminal`.
- `agentFunctions: false` stops offering `@nestjs/ai`'s agent functions; `agentFunctionCaller` maps the turn's actor to the call's `user` and `scopes` (default `{ user: actor }`).
