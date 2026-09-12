# @dudousxd/nestjs-agent-mcp

## 0.2.0

### Minor Changes

- [#118](https://github.com/DavideCarvalho/nestjs-agent/pull/118) [`3061f77`](https://github.com/DavideCarvalho/nestjs-agent/commit/3061f77548d48a8aa88b02eca46b04d24848646a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `McpToolsService.refresh` only ever added. A tool an MCP server had stopped exporting stayed
  registered, stayed in the catalog the model is offered, and failed at the remote when called — a
  tool the model is told it has and cannot use.

  It now hands those names back. The distinction that makes that safe is between a server that could
  not be REACHED and one that answered with an empty list: the first says nothing about what it
  offers, so nothing is retired; the second is a real answer. Only names the server OWNS are given
  back, so a name it lost a collision for — to the application, or to a server configured earlier —
  is untouched.

  `ToolRegistry.unregister(name)` is new, and is what the importer hands a name back through. The
  registry cannot tell whether a caller owns a name, so it does not try: whoever registered a name is
  responsible for tracking that it did, and unregistering one it does not own would silently take a
  tool away from whoever does.

## 0.1.1

### Patch Changes

- [#84](https://github.com/DavideCarvalho/nestjs-agent/pull/84) [`b7d2a75`](https://github.com/DavideCarvalho/nestjs-agent/commit/b7d2a750f32d8c12e8fff9501d5caff7d35f89e9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Say what `McpToolsService.refresh` returns — the count the re-imported servers just claimed, not the registry's total.

## 0.1.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `@dudousxd/nestjs-agent-mcp` — an MCP client, so an external Model Context Protocol server's
  tools can be imported instead of writing an `@AiTool` class for each.

  `AgentMcpModule.forRoot({ servers: [...] })` (and `forRootAsync`) connects to each server at boot,
  lists its tools, and registers them into the same `ToolRegistry` `@AiTool` discovery writes to — so
  an imported tool goes through every gate a hand-written one does: `roles`, `ability`, per-actor
  `canUse`, `enabled`, an agent's tool allow-list, HITL approval, and the tool-call rows the thread,
  the dashboard and Telescope already read. stdio and streamable HTTP ship with the package; anything
  else (OAuth, legacy SSE, an in-process pair in a test) plugs in as a custom transport. Built on the
  official `@modelcontextprotocol/sdk`.

  **An imported tool is `kind: 'action'` by default** — it waits for a human. This library
  auto-executes a `read` tool, and a tool defined on a remote server has effects that are not visible
  from the importing codebase. MCP servers may advertise `readOnlyHint`, but that hint is asserted by
  the very party whose effects it describes, so trusting it is opt-in (`kind: 'trust-annotations'`),
  as is `kind: 'read'` for a server you own and audit, or a per-tool predicate.

  The server's JSON Schema is enforced rather than approximated. Each tool's schema is compiled into
  the Standard Schema `ToolSpec.inputSchema` requires, so the model's arguments are validated against
  the real constraints — required properties, types, enums, `additionalProperties` — before the call
  goes out, and the same document is exposed through the Standard JSON Schema extension so the AI SDK
  adapter hands the model the real parameter shapes. A tool whose schema cannot be compiled is skipped
  with a warning instead of being imported behind a permissive stand-in.

  A slow or missing server costs its own tools and nothing else. An unreachable server at boot is a
  warning and its tools are absent (`required: true` opts into failing boot); a hung request hits the
  SDK's own per-request timeout, which cancels it on the wire; a dropped connection, a socket reset or
  a retryable HTTP status is classified transient by the exported `isTransientMcpError`, recycles the
  client, and is retried through core's `invokeWithTransientRetry` — the same in-place retry the agent
  loop already wraps every tool with, so a retry never becomes a second durable checkpoint. A
  protocol-level refusal is not retried. `McpToolsService.refresh(name?)` re-imports a server that was
  down at boot without a restart.

  Tool names are namespaced under their server (`github_create_issue`) and reshaped to what model
  providers accept, stably across restarts — the registry is keyed by name, so an un-namespaced import
  could otherwise replace an application tool silently. A collision with an already-registered name is
  refused and logged rather than overwritten.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make an imported tool name belong to exactly one server, and refuse a remote schema that can stall
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
