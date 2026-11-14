---
'@dudousxd/nestjs-agent-dashboard': minor
---

The console moves onto the shared Aviary console kit: a sidebar shell (console switcher, MONITOR · Spend & usage / Models / Reliability / Live, ACTIVITY · Runs & tools / Generative UI, GOVERNANCE · Approvals / Actors & budgets, CONFIG · Tools / Pricing, signed-in user, light/dark toggle, sign-out), a topbar with the organization, the day range, the live indicator and ⌘K, bundled Sora + JetBrains Mono, Tailwind 4 + React 19, shaped skeletons, error boundaries and empty states, light mode, and a phone-width drawer. Every page, route, drill-down and the access-denied page are kept.

⌘K lists the console's pages first and searches each console on its own, streaming the groups in as they answer (`GET <api>/consoles/search?q=&console=<id>` answers for one console). New `AgentDashboardModule.forRoot` options feed the sidebar footer: `viewer: (request) => ({ label, email?, role? })` (default: `request.user` read structurally) and `signOut: '/path' | { href } | { action, csrfToken? } | false` (default: the `account.signOut` an account console announces on the Aviary consoles registry). `AgentUiController.index()` is now async: a host subclass that overrides `index()` must make its override async too (`async index(request?): Promise<string>`).
