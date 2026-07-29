---
'@dudousxd/nestjs-agent-dashboard': patch
---

Fix the console launcher spinning forever after a Back navigation. `useOpenAgentConsole` keeps `isPending` true after a successful mint on purpose — the page is leaving, and clearing it flashes a "ready to click again" button. With the browser's back/forward cache the page is frozen rather than destroyed, so pressing Back restored the launcher with that flag still set: a permanent spinner on a permanently disabled button. The hook now clears `isPending` on `pageshow` with `persisted: true` — a bfcache restore only, so a fresh load and a mint that is still genuinely in flight both keep their current behaviour.
