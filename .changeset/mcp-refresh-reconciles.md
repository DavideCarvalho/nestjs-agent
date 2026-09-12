---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-mcp': minor
---

`McpToolsService.refresh` only ever added. A tool an MCP server had stopped exporting stayed
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
