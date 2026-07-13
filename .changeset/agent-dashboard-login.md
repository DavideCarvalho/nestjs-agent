---
'@dudousxd/nestjs-agent-dashboard': minor
---

Add `dashboardAuth`, a built-in cookie-session login screen for the AI-gateway console — the
simplest way to protect `/ai-gateway` when the host has no ready-made guard the console can reuse
(e.g. header-only auth a browser navigation can't attach). Mirrors
`@dudousxd/nestjs-telescope`'s `dashboardAuth` mechanics (stateless HMAC-SHA256 signed cookie,
`node:crypto` only, no JWT dependency), adapted to a server-rendered login page since this
package's console is a built React SPA with no auth-aware UI of its own:

- `AgentDashboardOptions.dashboardAuth: { secret, ttl?, login }` — a required signing secret, an
  optional cookie TTL (default `8h`, sliding renewal past 50% TTL), and a `login(username,
  password)` hook the host wires to its own user store. Missing `secret`/`login` is a boot error
  (fail closed).
- `AgentDashboardModule.forRootAsync({ useDashboardAuth, inject, ... })` for a `login` hook that
  needs injected services (e.g. an EntityManager) — `basePath`/`apiBasePath`/`guards` stay static
  (module-build-time), only the auth config is resolved through DI.
- A dependency-free login page at `<basePath>/auth/login` (GET renders the form, POST validates
  and mints the cookie) plus `POST <basePath>/auth/logout`. Bad credentials get a uniform,
  generic failure — the response is identical for an unknown user and a wrong password, so the
  endpoint never reveals which one was wrong.
- Built-in guards, no-ops unless `dashboardAuth` is configured: an unauthenticated PAGE navigation
  is redirected (302) to the login screen (with a `returnTo` honored after login); an
  unauthenticated API call gets `401`. Composes with the existing `guards` option — AND semantics,
  both gates must pass — via APPEND-onto-baseline guard stamping (`guards.ts`), replacing the
  previous straight-REPLACE semantics.
- Docs: a new "Console auth" section in the package README comparing `dashboardAuth` vs `guards`
  vs leaving the console open, with a cookie-guard example for the `guards` path.
