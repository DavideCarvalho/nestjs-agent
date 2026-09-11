---
'@dudousxd/nestjs-agent-core': patch
---

Apply an agent's tool allow-list before the gates that may do I/O, not after.

`ToolRegistry.definitionsFor` ran the allow-list last, so an agent pinned to three tools out of two
hundred still asked every gate about all two hundred: 200 `isEnabled` calls, 200 `RolesPolicy.can`
calls and 200 `canUse` calls, **once per model step**. With in-memory gates that is 0.1–1.8 ms and
would not be worth fixing. With I/O-backed ones — an authz service, a feature-flag store,
MCP-imported tools — it is 3N round trips per step: measured 4.7 ms per step against 1 ms gates,
16 ms against 5 ms gates, and 180 calls per step at a connection pool.

The allow-list is a pure name-set match that only ever removes, and the method's contract is that
every layer only removes, so the order cannot change what a turn reaches. It now runs first; the
three gates see only the tools that can still be offered. Same tools, in the same order.
