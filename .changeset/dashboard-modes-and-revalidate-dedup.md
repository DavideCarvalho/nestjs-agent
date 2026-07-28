---
'@dudousxd/nestjs-agent-dashboard': patch
---

**`dashboardAuth` fixes: `modes` is now load-bearing, and `revalidate` no longer stampedes under concurrent requests.**

- `ResolvedDashboardAuth.modes` (computed by `resolveDashboardAuth`, exported on the published type) is now the single source of truth every mode-gated route reads — `DashboardAuthPageGuard`'s deny target and `AgentDashboardAuthController`'s login/session/session-required/logout branches all switched from hook-presence truthiness (`!!auth.login`/`!!auth.session`) to `auth.modes.includes(...)`. For any config built through `resolveDashboardAuth` (the only supported path) this is behavior-neutral — `modes` and hook presence were always in sync there by construction. It only matters for a host that hand-builds `ResolvedDashboardAuth` directly (bypassing the resolver) with `modes` and hook presence disagreeing; that case now follows `modes`.
- `revalidate` de-dupes concurrent renewals of the same session (same user + cookie generation) into a single host call. Previously every in-flight request carrying the same past-half-life cookie invoked `revalidate` independently — a console page load firing N parallel API calls could trigger up to N host round-trips before the refreshed cookie landed. Each request still gets its own renewed `Set-Cookie`; only the host round-trip is now shared. The `RevalidateHook` doc comment is corrected to match.

No action needed for existing `dashboardAuth` configs — both fixes are behavior-neutral for any config built the normal way (via the `dashboardAuth` module option).
