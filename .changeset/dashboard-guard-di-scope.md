---
"@dudousxd/nestjs-agent-dashboard": patch
---

Guards with dependencies now resolve: guard classes and the host's `imports` are threaded into
`AgentApiModule` (the API controller's HOST module) and registered as providers on both host
modules — enhancers DI-instantiate from their controller's own module, never a parent, so the
previous wiring failed boot with "Nest can't resolve dependencies ... in the AgentApiModule
context" for any guard that injects something.
