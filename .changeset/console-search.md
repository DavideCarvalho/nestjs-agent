---
'@dudousxd/nestjs-agent-dashboard': minor
---

Global search across the Aviary consoles. A console entry may expose `search(context, q, limit)`; `GET <api>/consoles/search?q=` fans out to this console and every other console the viewer may open (300 ms and 5 hits each, `partial: true` when one did not answer). The agent console searches runs and threads (exact ids, thread titles, agent names), scoped by tenancy like its other reads. The console gets a Ctrl/Cmd-K search palette, a Search button and a "Search all consoles" item in the switcher menu; hits open the run or thread drill-down (`#/runs?run=<id>`, `#/runs?thread=<id>`). While the switcher runs another console's `authorize`, the request carries `aviaryProbe = true`, so an auditing authorizer can skip it.
