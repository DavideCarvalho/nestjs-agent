---
'@dudousxd/nestjs-agent-dashboard': patch
---

Fix: the built-in `dashboardAuth` login screen no longer rejects an empty password before it
reaches the host `login` hook. Previously `AgentDashboardAuthController` blocked any POST with a
blank password with the generic uniform-failure redirect, so a host whose `login` hook only checks
the username/email (password deliberately ignored) could never sign in through the built-in form.

Password is now optional end-to-end: `username` stays required (non-empty, trimmed), and
`password` is passed through to `login` AS-IS — `''` when blank or omitted — so the hook alone
decides whether an empty password is accepted. The uniform-failure semantics (identical response
for an unknown user and a wrong/rejected password, no user enumeration) are unchanged. A malformed
password shape (present but not a string) is still rejected before the hook runs.
