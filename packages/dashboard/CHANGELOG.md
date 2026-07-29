# @dudousxd/nestjs-agent-dashboard

## 0.13.1

### Patch Changes

- [#41](https://github.com/DavideCarvalho/nestjs-agent/pull/41) [`a32a2da`](https://github.com/DavideCarvalho/nestjs-agent/commit/a32a2daedd07ea1fe2aa8297b3d4fbb3de8178aa) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the console launcher spinning forever after a Back navigation. `useOpenAgentConsole` keeps `isPending` true after a successful mint on purpose — the page is leaving, and clearing it flashes a "ready to click again" button. With the browser's back/forward cache the page is frozen rather than destroyed, so pressing Back restored the launcher with that flag still set: a permanent spinner on a permanently disabled button. The hook now clears `isPending` on `pageshow` with `persisted: true` — a bfcache restore only, so a fresh load and a mint that is still genuinely in flight both keep their current behaviour.

## 0.13.0

### Minor Changes

- [#37](https://github.com/DavideCarvalho/nestjs-agent/pull/37) [`8378970`](https://github.com/DavideCarvalho/nestjs-agent/commit/8378970805d0e420108966f9af79ef978351af6f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **React tier for the console launcher: `useOpenAgentConsole` / `openAgentConsoleMutationOptions` / `<OpenAgentConsoleButton>`, from the new `@dudousxd/nestjs-agent-dashboard/react` subpath.**

  `openAgentConsole` is headless on purpose, but every React host was then rewriting the same three
  things around it: an in-flight flag, an error slot, and a button that disables itself. Three tiers
  now, pick the one that fits:

  ```tsx
  import { OpenAgentConsoleButton } from "@dudousxd/nestjs-agent-dashboard/react";

  <OpenAgentConsoleButton
    headers={() => ({ Authorization: `Bearer ${token()}` })}
  />;
  ```

  - **`<OpenAgentConsoleButton>`** — drop-in. Deliberately unstyled: a bare `<button>` that forwards
    `className`/`style`/every other button prop, so it inherits the host's design system rather than
    importing CSS that fights it. Disables itself and sets `aria-busy` while the mint is in flight.
    A refusal renders as `<p role="alert">` by default — a launcher that silently does nothing reads
    as broken rather than forbidden. `renderError` substitutes your own node; `renderError={null}`
    opts out for a host that surfaces errors its own way.
  - **`useOpenAgentConsole(options?)`** → `{ open, isPending, error, reset }` — the state a launcher UI
    needs, your markup. `open()` never rejects; the refusal lands in `error` as `ConsoleSessionError`.
    It deliberately does **not** clear `isPending` on success: the navigation is already underway, and
    flipping back to idle flickers "ready to click again" on a page that is leaving.
  - **`openAgentConsoleMutationOptions(options?)`** → `{ mutationKey, mutationFn }` — the shape
    `useMutation` takes, so a host already on TanStack Query wires the launcher into its own cache,
    devtools and error handling with no adapter. This package never imports `@tanstack/react-query`,
    so a host that doesn't use Query pays nothing.

  `react`/`react-dom` are **optional** peer dependencies: a host that only mounts
  `AgentDashboardModule` is not forced to install React. The `./react` entry also re-exports the
  `./client` console-session primitives, so a React consumer needs one import path rather than two.

  Additive only: nothing existing changes.

## 0.12.0

### Minor Changes

- [#35](https://github.com/DavideCarvalho/nestjs-agent/pull/35) [`8cac7dd`](https://github.com/DavideCarvalho/nestjs-agent/commit/8cac7dd65ef59b778f32e633ccaa4ec1d3f9d0a3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Headless console launcher: `openAgentConsole` / `mintAgentConsoleSession` / `agentConsoleSessionUrl`, exported from `@dudousxd/nestjs-agent-dashboard/client`.**

  The console is entered from the HOST's app: a browser navigation to it carries no identity, so
  something inside the host has to mint the Mode A session cookie first (an XHR that _does_ carry the
  host's auth), then navigate. Every host was writing that by hand, which meant hardcoding two things
  this package owns:

  - **the session endpoint's path** — `<basePath>/auth/session`. Nothing tells a host when that moves; the break
    only shows up as a runtime 404 after a version bump.
  - **`redirect: 'manual'`** — and this one is a real trap. `fetch` follows redirects by default, so a
    host whose auth layer rewrites a 401 into a sign-in redirect gets a resolved 200 against the
    sign-in HTML. `response.ok` reads true, the caller navigates, and the user lands in a console with
    no session — indistinguishable from a permissions bug. The helper detects the redirect (browser
    opaque response _and_ Node/undici 3xx) and throws a message naming the likely cause.

  ```ts
  import { openAgentConsole } from "@dudousxd/nestjs-agent-dashboard/client";

  await openAgentConsole({
    headers: () => ({ Authorization: `Bearer ${token()}` }),
  });
  ```

  No UI: the host owns the button, the page and the copy. `headers` accepts a sync or async function
  so a refreshing token is read at call time rather than captured at wiring time. `fetch` and
  `navigate` are injectable (tests, routers, non-browser callers). A refused mint throws
  `ConsoleSessionError` (carrying `status` and `url`) and **does not navigate** — a denied user gets a
  real error instead of the console's "no session" page.

  Additive only: nothing existing changes.

## 0.11.0

### Minor Changes

- [#33](https://github.com/DavideCarvalho/nestjs-agent/pull/33) [`a67ccd9`](https://github.com/DavideCarvalho/nestjs-agent/commit/a67ccd9fefe4605816995a78c4da9f69495000c9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **`dashboardAuth.unauthenticatedPage` — hosts can now render the console's unauthenticated page themselves.**

  Under Mode A, a browser reaching the console without a session is redirected to
  `<basePath>/auth/session-required`, which served a fixed, library-rendered card: _"Open this console
  from your application."_ Deliberately generic, because the library cannot know who hosts it — it
  can't name the host's launcher, link to it, or look like the rest of the host's product.

  The new `unauthenticatedPage` hook hands the whole response to the host:

  ```ts
  dashboardAuth: {
    secret: process.env.AGENT_DASHBOARD_SECRET,
    session: (request) => resolveAdmin(request),
    unauthenticatedPage: ({ request, response, basePath }) => {
      (response as Response).status(401).render('console-locked', { returnTo: basePath });
    },
  }
  ```

  It receives the platform-native request/response (Express, Fastify — same `unknown` typing as
  `session`, for the same reason) plus `basePath`, and owns the response: it must write AND end it. It
  changes what `<basePath>/auth/session-required` _contains_, not the flow that reaches it, so the
  existing redirect behaviour is untouched.

  Fail-closed by construction: the hook only ever runs on a request that has ALREADY been denied, so
  it cannot grant access — an accompanying test asserts the API stays `401` and a page navigation is
  still bounced even when the hook answers `200`. A hook that throws, or that returns without writing,
  logs one warning and falls back to the built-in page rather than hanging the request or turning a
  denial into a `500`. It is also not a mode: `unauthenticatedPage` alone still fails boot on the
  existing "at least one of `session` or `login`" check. Under Mode B the route continues to `404` —
  configuring a page hook does not conjure it into being.

  Not a replacement for Mode B's built-in login form. A host that wants its own _login_ UI combines
  Mode A with this hook and posts to `<basePath>/auth/session` from its own page; that mint endpoint
  is the supported primitive for it.

  Fully backward compatible — omit the option and the built-in page is unchanged.

## 0.10.1

### Patch Changes

- [#28](https://github.com/DavideCarvalho/nestjs-agent/pull/28) [`bbea1b7`](https://github.com/DavideCarvalho/nestjs-agent/commit/bbea1b70bb4feebbefffb8f96d4781770d44be9d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **`dashboardAuth` fixes: `modes` is now load-bearing, and `revalidate` no longer stampedes under concurrent requests.**

  - `ResolvedDashboardAuth.modes` (computed by `resolveDashboardAuth`, exported on the published type) is now the single source of truth every mode-gated route reads — `DashboardAuthPageGuard`'s deny target and `AgentDashboardAuthController`'s login/session/session-required/logout branches all switched from hook-presence truthiness (`!!auth.login`/`!!auth.session`) to `auth.modes.includes(...)`. For any config built through `resolveDashboardAuth` (the only supported path) this is behavior-neutral — `modes` and hook presence were always in sync there by construction. It only matters for a host that hand-builds `ResolvedDashboardAuth` directly (bypassing the resolver) with `modes` and hook presence disagreeing; that case now follows `modes`.
  - `revalidate` de-dupes concurrent renewals of the same session (same user + cookie generation) into a single host call. Previously every in-flight request carrying the same past-half-life cookie invoked `revalidate` independently — a console page load firing N parallel API calls could trigger up to N host round-trips before the refreshed cookie landed. Each request still gets its own renewed `Set-Cookie`; only the host round-trip is now shared. The `RevalidateHook` doc comment is corrected to match.

  No action needed for existing `dashboardAuth` configs — both fixes are behavior-neutral for any config built the normal way (via the `dashboardAuth` module option).

## 0.10.0

### Minor Changes

- [#26](https://github.com/DavideCarvalho/nestjs-agent/pull/26) [`a5e34a9`](https://github.com/DavideCarvalho/nestjs-agent/commit/a5e34a9ef8f9013aba6113e719dd2a0ce6e67500) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Dashboard auth gains Mode A (`session`) and a `revalidate` hook; `login` is now optional.** Previously the AI-gateway console could only be gated by the built-in, server-rendered `login` screen — forcing a host that already has its own identity provider (SSO/OIDC/whatever) to invent a shared credential this library could check. And once a session cookie was minted, the sliding renewal that kept an active tab logged in never re-checked the user, so a deactivated or demoted operator kept console access for as long as the tab stayed open.

  - `dashboardAuth.session?: (request) => SessionUser | null` — the host frontend, already carrying its own auth, POSTs to `<basePath>/auth/session`; the hook validates the raw request and returns the session user (or `null` to deny), and the library mints its usual signed cookie from that. No credential this library understands ever exists.
  - `dashboardAuth.login` is now optional (Mode B, a standalone fallback with no host frontend/IdP to lean on) — at least one of `session`/`login` is still required, or `resolveDashboardAuth` throws at boot (an un-mintable gate is a boot error, not a silently-open or silently-stuck console).
  - A Mode-A-only mount serves a small instruction page in place of the login redirect (there is no login page to redirect to) when a page-level request has no valid session.
  - `dashboardAuth.revalidate?: (session) => Promise<boolean> | boolean` — re-checks a _live_ session on the sliding renewal path (at most once per `ttl/2` per cookie generation, per in-flight request — concurrent requests still carrying the same not-yet-renewed cookie each invoke it, so a page load firing N parallel calls can trigger up to N before the refreshed cookie lands). Returning `false`, or throwing, clears the cookie and denies the request in place — the same treatment as an absent cookie. Distinct from `session`: that hook reads the host's own auth off a fresh request, which a console XHR does not carry; `revalidate` receives the already-minted session instead. `revalidate` alone cannot mint a session, so it doesn't count toward the `session`/`login` "at least one" requirement.

  Compatible with existing `dashboardAuth: { secret, login }` configs unchanged.

## 0.9.1

### Patch Changes

- [`dc4a586`](https://github.com/DavideCarvalho/nestjs-agent/commit/dc4a5866c3225602c8887c569751f5e5ceedf830) - Fix: the built-in `dashboardAuth` login screen no longer rejects an empty password before it
  reaches the host `login` hook. Previously `AgentDashboardAuthController` blocked any POST with a
  blank password with the generic uniform-failure redirect, so a host whose `login` hook only checks
  the username/email (password deliberately ignored) could never sign in through the built-in form.

  Password is now optional end-to-end: `username` stays required (non-empty, trimmed), and
  `password` is passed through to `login` AS-IS — `''` when blank or omitted — so the hook alone
  decides whether an empty password is accepted. The uniform-failure semantics (identical response
  for an unknown user and a wrong/rejected password, no user enumeration) are unchanged. A malformed
  password shape (present but not a string) is still rejected before the hook runs.

## 0.9.0

### Minor Changes

- [`f614883`](https://github.com/DavideCarvalho/nestjs-agent/commit/f614883c65685f1aeb494a43aaab93e30a281281) - Add `dashboardAuth`, a built-in cookie-session login screen for the AI-gateway console — the
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

## 0.8.0

### Minor Changes

- [`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f) - Console navigability + paginated, queryable lists:

  - Sections live on ROUTES now — hash routing (`/ai-gateway#/reliability`, `#/approvals`, …),
    deep-linkable on full page load, consistent with the durable console, zero new dependencies.
  - The list surfaces (tool calls, threads, runs) are paginated and filterable end to end:
    `AgentGovernanceQueries` grew `toolCallsPage`/`threadsPage`/`runsPage` (neutral
    `GovernancePageQuery` with typed `where` — REQUIRED members, implemented in both bundled stores
    with real COUNT + offset, deterministic id tiebreaks, case-insensitive title search, one-sided
    day bounds; in-memory testing impls included). The dashboard API speaks the ecosystem's familiar
    wire grammar (`page`, `limit`, `where[field]=value`, unknown field → 400) and the SPA tables get
    prev/next pagination with per-table debounced filters. The latest-N reads remain for the
    telescope bridge.

## 0.7.0

### Minor Changes

- [`71b8d42`](https://github.com/DavideCarvalho/nestjs-agent/commit/71b8d42d211d28516929298c44e6868d8925cc02) - Live-testing fixes from the first dispatched-steps consumer:

  - **CRITICAL — durable turns on the BullMQ thin worker no longer corrupt their history.** The
    workflow's control-flow classification used `instanceof WorkflowSuspended`, but the thin worker's
    suspends throw `@dudousxd/durable-worker`'s `Suspend` — a different class — so every dispatched
    llm step's suspend was misclassified as a real failure: the failure path ran DURING the suspend,
    emitted extra checkpoints, and the resumed replay died with NondeterminismError ("Something went
    wrong: workflow suspended" on every turn). All three classification sites (workflow catch, the
    loop's `isControlFlowError` hook, the runner's start-suspend swallow) now use durable-core
    0.52.0's marker-based `isWorkflowControlFlowSignal` — the peer floor rises to
    `@dudousxd/nestjs-durable-core >= 0.52.0` accordingly.
  - **Dashboard mounted in an Inertia host:** an Inertia `<Link>` visit to the console received plain
    HTML and rendered it inside the client's about:srcdoc error modal, where relative assets die on
    CORS. The UI controller now answers `X-Inertia` requests with the protocol's own external-redirect
    mechanism (`409` + `X-Inertia-Location`), so in-app links full-load the console correctly.
  - **Approvals attribution defaults to the AgentModule-configured actor resolver** (`@Global`,
    already exported) — zero config for hosts whose console auth matches chat auth; the
    `approvalActorRef` override is now generically typed (`AgentDashboardOptions<TReq>`, mirroring
    `ActorResolver<TReq>`) for hosts where it differs.

## 0.6.0

### Minor Changes

- [`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263) - Governance wave — approvals inbox, tool stats, prompt hash:

  - **HITL approvals inbox**: new `AGENT_APPROVAL_PORT` SPI (`AgentApprovalPort`) bound by the agent
    runtime — console-side approve/reject routed through the SAME decision path chat approvals use
    (durable signal or inline resolution), WITHOUT re-authorization (the console's own guards front
    it). `Decision` gained optional `executedByRef`; the loop persists the decider on both executed
    and rejected action tools (`decision.executedByRef ?? the run's actor`). Governance read
    `pendingApprovals(limit)` (oldest first, joined to thread/actor). Dashboard: Approvals section
    (pending list, approve/reject with reason, nav badge) + `GET approvals` / `POST
approvals/:toolCallId`; new `approvalActorRef` dashboard option stamps WHO decided from the live
    request; the API returns 501 (and the SPA renders read-only) when no port is bound.
  - **Tool governance**: `toolStats(range)` — per-tool calls/failed/rejected + p95 executionMs —
    and a dashboard Tools section.
  - **Prompt hash**: each run records the sha256 of its resolved system prompt (pre-RAG, so it
    identifies the prompt VERSION), surfaced on recent runs in the dashboard — correlate error-rate
    shifts with prompt changes.

## 0.5.0

### Minor Changes

- [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5) - Run reliability metrics — run outcomes are now durably recorded and surfaced as governance reads
  and a dashboard Reliability section:

  - Store SPI: optional `recordRunStart`/`recordRunEnd`/`bumpRunRetries` on `AgentStore` (absent =
    graceful no-op). The loop records start/completed (with duration) as checkpointed steps; the
    runners (durable workflow + inline) record failures with error code/message. Both bundled store
    adapters ship the new `agent_run` table (autoSchema-managed, in the managed-tables lists).
  - `AgentGovernanceQueries` grew `runMetrics`, `runsByAgent`, `runErrors`, `runTrend`, `recentRuns`
    (REQUIRED members — external adapters must implement them; return zeros/empty when the backing
    store never records runs). In-memory testing impls included.
  - Dashboard: `GET <api>/reliability?from&to` + `GET <api>/runs?limit`, and a Reliability section in
    the SPA — success/error rate, retries, p95 duration, run/failure trend, failure breakdown by
    error code, recent runs table.
  - `DispatchedLlmInput` carries `runId` so llm-step retries can be attributed to the run; the retry
    counter stays 0 until the durable runtime exposes the attempt number to remote step handlers.

## 0.4.1

### Patch Changes

- [#5](https://github.com/DavideCarvalho/nestjs-agent/pull/5) [`619a097`](https://github.com/DavideCarvalho/nestjs-agent/commit/619a09771830db31739594813b0b937b844939f6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Guards with dependencies now resolve: guard classes and the host's `imports` are threaded into
  `AgentApiModule` (the API controller's HOST module) and registered as providers on both host
  modules — enhancers DI-instantiate from their controller's own module, never a parent, so the
  previous wiring failed boot with "Nest can't resolve dependencies ... in the AgentApiModule
  context" for any guard that injects something.

## 0.4.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/nestjs-agent/pull/3) [`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `AgentDashboardModule.forRoot()` gains a first-class `guards` option (`Type<CanActivate>[]`, stamped
  on both the SPA and API controllers via `@nestjs/common`'s own `@UseGuards` metadata — REPLACE
  semantics) plus an `imports` passthrough for the guards' own dependencies, replacing the "front the
  routes with your own guard" doc note with a real mechanism. A new `agentDashboardMountPaths()` helper
  returns the four route roots (UI + API, each with a `{*splat}`) a host's `setGlobalPrefix('api',
{ exclude })` needs to keep the dashboard resolving outside the prefix — mirrors
  `telescopeMountPaths()`.

  Every actor-scoped API row (`spend().byActor`, `GET top-threads`, `GET threads`) now carries an
  additive `actorLabel: string | null`, resolved via the optionally-injected `AGENT_ACTOR_DIRECTORY`
  (batched into one `resolveDisplay()` call per response) — `null` on every row when nothing is bound,
  so existing consumers keep working unchanged. `ActorsSection` renders the label when present.

  The dashboard API gains pricing CRUD backed by the optionally-injected `AGENT_PRICING_STORE`:
  `GET <api>/pricing` (list current prices) and `POST <api>/pricing` (upsert a model's price, minimally
  validated), both 501ing with a clear message when no pricing store is bound. A new "Pricing" tab in
  the SPA lists current rates and offers a minimal upsert form, replacing the hand-written pricing
  controller + curation UI consumers otherwise maintain themselves.

## 0.3.1

### Patch Changes

- [`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04) - Governance queries: add `spendByThread(range, limit)` (top threads by cost) and
  `ActorSpendRow.threadCount`. Cost is now priced through the injected
  `AGENT_PRICING_STORE` instead of reading `agent_model_pricing` directly, and both
  store modules accept a `pricingStore` option so a host can bind its own pricing
  table as the single source of cost truth for every governance surface. Default
  behavior (the store's own pricing table) is unchanged.

  The dashboard (`/ai-gateway`) and the Telescope Agent tab gain a "Top threads by
  cost" panel fed by `spendByThread`.
