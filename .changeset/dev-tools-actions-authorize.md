---
"@dudousxd/nestjs-agent-mcp-server": minor
---

`devTools.actions` is now authorized per caller. Besides `'refuse'`, `'execute'` and a list, it takes a map of lib ids or tool names to a console `authorize` (`{ durable: authorizeByToken({ token }), durable_cancel_run: (ctx) => … }`, a tool key winning over its lib's), or a function `(request, { lib, tool, destructive, caller }) => boolean`. A refused action is neither listed nor callable; an action matching no key, a throw or `{ redirectTo }` refuses; each `authorize` runs once per request; refusals log at `debug`. The instructions say read-only unless the request is actually served an action. New types: `DevToolsActions` (widened), `DevToolsActionsMap`, `DevToolsActionsAuthorizer`, `DevToolsActionRequest`. The dev-tools contract version is unchanged.
