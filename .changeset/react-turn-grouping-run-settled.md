---
'@dudousxd/nestjs-agent-react': minor
---

Stored-history UX parity with the live stream:

- `storedThreadToUiMessages(messages)` merges consecutive assistant rows (one model TURN persists
  one row per iteration) into a single `UIMessage` with parts concatenated in step order — a
  reloaded thread renders one response bubble per turn, matching the live stream, instead of 2-3
  fragments each with its own footer. Merged turns carry `metadata.usage` with summed tokens and
  cost (`costUsd` stays `null` only when every merged row's cost is unknown — unknown ≠ $0).
  `storedMessageToUiMessage` (1:1) is unchanged.
- `useAgentChat({ onRunSettled })` — fires exactly once per run with
  `{ runId, status: 'completed' | 'failed' }` when the stream settles (send and resume paths). The
  server has persisted the thread title and run outcome by then — refetch thread/list queries here
  (fixes "Untitled" never updating in headers/sidebars).
