---
"@dudousxd/nestjs-agent": major
"@dudousxd/nestjs-agent-dashboard": minor
---

Who reaches the agent's routes is decided only with NestJS's own tools — `decorators` on the module, or the app mounts the routes itself (`routes: false`) — with `@nestjs/authentication` / `@nestjs/authorization`. The options that did it before are gone:

- `guards` on `AgentModule` and on the media upload routes → `decorators: [UseGuards(MyGuard)]` (a function works too, as a guard instance: `UseGuards({ canActivate })`).
- The AI-gateway console's own sign-in — `dashboardAuth` (session and login modes), its `/auth/*` routes, the session cookie, `forRootAsync` (which only built `dashboardAuth`), and the `/react` launcher and `/client` session helpers (`openAgentConsole`, `OpenAgentConsoleButton`) → the app's own session, and `decorators` or `routes: false` on `AgentDashboardModule`; its `guards` → `decorators`.
- In production the console refuses to boot with neither `decorators` nor `routes: false`, so it is never served open by default.

An engine's own controllers (OpenCode's tools endpoint) keep their own authentication and do not take the app's `decorators`.
