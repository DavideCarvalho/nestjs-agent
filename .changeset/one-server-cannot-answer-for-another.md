---
'@dudousxd/nestjs-agent-mcp': minor
---

Make an imported tool name belong to exactly one server, and refuse a remote schema that can stall
the process validating against it.

**A name has one owner.** The collision check was service-wide: it protected the application's own
tools, but once one MCP server had registered `deploy`, a second server exporting `deploy` passed the
check and REPLACED the first server's handler with no warning. The model went on calling `deploy`,
and `deploy` now reached somebody else's server. Reachable with `namespace: false` or a shared
`namespace` string, both documented options — and because `refresh()` re-imports every server under
`Promise.all`, which server ended up owning the name could change from boot to boot. Registration
bookkeeping is now keyed by server, a cross-server claim on a live name is logged and skipped exactly
as an application-tool collision is, and registration replays in CONFIGURATION order after the
parallel `tools/list` calls, so the server listed first owns a contested name on every boot. Two
servers configured under the same `name` are refused at boot: that collision is statically
detectable, and a shared name leaves `refresh(name)`, the logs, the ownership map and the default
tool prefix all pointing at an arbitrary member of the pair.

**A `pattern` is a denial of service the server gets to write.** `{"pattern": "(a+)+$"}` is a legal
JSON Schema, and every validator in the MCP SDK compiles it to a native backtracking `RegExp`:
validating a 24-character string against it took 1.0s of uninterruptible CPU on the measuring
machine, 30 characters 7.8s, and the growth is exponential. The pattern comes from the server and the
string comes from the model, which the same server's tool description is free to steer — the whole
attack fits in one tool definition. Schemas are now screened at import for an unbounded repetition
whose body can match the same text more than one way (`(a+)+`, `(a*)*`, `(\s*\w+)*`, `(a+|b+)+`), and
a tool carrying one is dropped with a warning exactly like a tool whose schema will not compile. The
screen is structural rather than a decision procedure — `(ab|abc)+` is ambiguous across alternatives
and is not flagged — so a host that needs a guarantee gives `validator` an engine that does not
backtrack (AJV's `code.regExp` takes an RE2 binding) and sets `rejectUnsafePatterns: false`.
`isUnsafeRegex` and `findUnsafePattern` are exported for a host that wants to screen its own config.

**An imported server is now documented as a trust boundary.** A tool's description rides into the
tool list of every turn and every tool result into the transcript, both as text this process did not
write. The library still does not rewrite either — a client that silently edited a server's
descriptions would be lying about what you are running — but the README and the docs site now state
the exposure plainly, list the levers that bound it (the `action` default, `include`, roles, an
agent's allow-list) and carry a worked `InputProcessor` recipe for fencing tool output as data, with
its limits named: a description is never in the transcript, so no processor can see one.
`McpToolsService.importedTools()` reports every imported tool, its server, its remote name and the
description it supplied, which is what makes reviewing and fencing them possible.
