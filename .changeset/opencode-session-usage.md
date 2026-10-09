---
"@dudousxd/nestjs-agent-opencode": patch
---

Record the title OpenCode generates (and a compaction) even though OpenCode 2.0 does not stream those calls: a turn reads the session's spend (`session.get`) before it prompts and, when the execution ends, records what the session spent that its steps did not report as a `title` (or `history_summary`) usage row, counted in the run's usage. `OpenCodeClient.session.get` may return the session's `cost` and `tokens`.
