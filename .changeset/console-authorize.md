---
"@dudousxd/nestjs-agent-dashboard": minor
"@dudousxd/nestjs-agent-core": patch
---

The governance console takes one `authorize` option, the same contract as every Aviary console.

- `AgentDashboardModule.forRoot({ authorize })` decides who reaches the SPA and every API/SSE route. It accepts an inline function, an `@Injectable()` `ConsoleAuthorizer` class, a lazy import of one, `{ policy, ability }` from `@nestjs/authorization`, or a gate name from `@dudousxd/nestjs-authz`. It runs after your `decorators`, so `request.user` is set.
- Denials: `403 { error: 'forbidden' }` (an access-denied page for a browser navigation), `401 { error: 'unauthenticated' }`, and `{ redirectTo }` → `302` for a page, `401` JSON with `redirectTo` for the API. A throwing `authorize` is a `403`. The SPA follows `redirectTo` and shows an access-denied screen on `403`.
- New exports: `authorizeByToken({ token })` (Bearer header, timing-safe), `resolveConsoleAuthorize`, `ConsoleAuthorizeGuard`, `ConsoleAuthorized()` for controllers you mount yourself with `routes: false`, and the `ConsoleAuthorize*` types. The `/client` subpath exports `onConsoleAccess(listener)`.
- **Breaking:** the console no longer refuses to boot in production without `decorators`. Without `authorize` it is open outside production, answers `403` to every request in production, and logs one warning at boot. `decorators` no longer count as protection: move the access decision to `authorize` (e.g. `decorators: [UseGuards(AuthenticationGuard)], authorize: { policy: ConsolePolicy, ability: 'view' }`).
- `@nestjs/authorization` is now an optional peer (used only by the `{ policy, ability }` form).

`-core`: the `ActorResolver` docs now say what happens without one (the anonymous resolver), not that it throws.
