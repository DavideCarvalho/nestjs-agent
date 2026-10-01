---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-mcp-server": minor
"@dudousxd/nestjs-agent-authz": minor
---

`emptyRoles: 'deny'` — a ready-made closed roles gate, for apps where an empty roles list means "no one".

**Upgrade note for core 0.27, which did not say it outright:** since 0.27 `DefaultRolesPolicy` treats an empty roles list as **open** — before, `[]` denied everyone. So `roles: []` on a tool, `defaultRoles: []`, and any computed `roles` that can come out empty went from reaching nobody to reaching every resolved actor, with no error and no warning.

The default does not change — an empty list is still open, which is what makes `AgentModule.forRoot({ model })` a working chat. What is new is the switch to keep it closed:

```ts
AgentModule.forRoot({ model, emptyRoles: 'deny' }); // binds ClosedRolesPolicy
AgentMcpServerModule.forRoot({ name, version, auth, emptyRoles: 'deny' }); // the MCP surface alone

new ClosedRolesPolicy(defaultRoles); // = new DefaultRolesPolicy(defaultRoles, { emptyRoles: 'deny' })
closeEmptyRoles(policy); // close a policy you did not build
new AuthzRolesPolicy(gate, { emptyRoles: 'deny' }); // its role fallback
```

Closed, the actor needs a role the tool declares (else one of `defaultRoles`): a tool with no `roles` and no default roles, or with an explicitly empty list, is neither offered nor invocable. `emptyRoles` on `AgentModule` is ignored when you pass your own `rolesPolicy`.
