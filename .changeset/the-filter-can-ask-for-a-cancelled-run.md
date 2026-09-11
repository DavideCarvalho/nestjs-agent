---
'@dudousxd/nestjs-agent-dashboard': patch
---

Offer `cancelled` in the run status filter.

The recent-runs table is filtered server-side, so the dropdown is the only way to ask for a status —
and it listed `running`, `completed` and `failed`. Cancelled runs were being written and were
unreachable in the console: the one terminal an operator most often wants to exclude from a failure
count could not be selected, in or out.

The terminals now come from a `Record<RecordRunEndInput['status'], string>`, so a fourth terminal
added to the SPI has to be answered for here before this file compiles.

**Upgrading.** Nothing to run — a dashboard asset rebuild picks it up.
