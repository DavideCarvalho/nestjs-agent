---
"@dudousxd/nestjs-agent-dashboard": minor
---

Console switcher: when other Aviary consoles are mounted in the same app, the governance console's brand becomes a menu linking to the ones the viewer may open (each one's own `authorize` decides). The console lists itself as "Agents" while its routes are mounted. New `GET <apiBasePath>/consoles`, behind the console's `authorize`. The page now carries a JSON config block (`agent-dashboard-config`).
