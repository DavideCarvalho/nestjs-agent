---
'@dudousxd/nestjs-agent-dashboard': minor
'@dudousxd/nestjs-agent-transport-redis': minor
---

Federated agent console: `AgentDashboardModule.forRoot({ federation: { apps: { [name]: { queries, approvals?, pricing?, label? } } } })` lets one hub console show the threads, runs, tool calls and approvals of several apps. The viewer picks the app with a switcher (`?app=<name>`, sent as the `x-agent-app` header). Reads come from the selected app's own store; approve/reject run on the app, sent over its Redis with the new `RedisConsoleApprovalClient` and answered by the app's `RedisConsoleActionResponder` through its own approval port. `authorize` can grant an `apps` list; an unknown or ungranted app answers 404. The live feed and setting prices stay on the hub's own process and answer 501 for a federated app, with a notice in the console.
