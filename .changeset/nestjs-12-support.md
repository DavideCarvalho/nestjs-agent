---
'@dudousxd/nestjs-agent': patch
'@dudousxd/nestjs-agent-authz': patch
'@dudousxd/nestjs-agent-dashboard': patch
'@dudousxd/nestjs-agent-rag-media': patch
'@dudousxd/nestjs-agent-store-drizzle': patch
'@dudousxd/nestjs-agent-store-mikro-orm': patch
---

Add NestJS 12 to the supported peer range.

Every `@nestjs/common`, `@nestjs/core` and `@nestjs/platform-express` peer that read
`^10.0.0 || ^11.0.0` now reads `^10.0.0 || ^11.0.0 || ^12.0.0`. NestJS 12.0.1 shipped the framework
as pure ESM and raised its floor to Node >= 20.19; these packages are already `"type": "module"`,
so nothing needed porting — the turn loop, the `/api/agent/*` controllers, HITL approval as a durable
signal, the stores and the dashboard all behave identically on 11 and 12.

The dev and test matrix moved to the 12.x line with the ranges, including the demo app, so the added
range is tested rather than merely declared: build, both typecheck passes, and the unit and
database suites are green against 12.0.1.

11 and 10 stay in every range. Nothing in the source depends on a 12-only API, so the widened range
is additive and a consumer still on 11 sees no change.
