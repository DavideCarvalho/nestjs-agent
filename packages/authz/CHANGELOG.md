# @dudousxd/nestjs-agent-authz

## 0.4.0

### Minor Changes

- [#227](https://github.com/DavideCarvalho/nestjs-agent/pull/227) [`cd2c790`](https://github.com/DavideCarvalho/nestjs-agent/commit/cd2c7909df1c88cc914ec6aa28940800e0dcd705) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Zero-config server: `AgentModule.forRoot({ model })` is the whole setup.

  - **Store**: omit `store` and `AgentModule` uses the `AGENT_STORE` another module binds (a store module — found by scanning the container, whatever the import order), else the built-in in-memory store with a boot warning that it is not for production. `InMemoryAgentStore` moves into `@dudousxd/nestjs-agent-core` (the `-testing` package re-exports it).
  - **Identity**: `actorResolver` is optional. Without one the endpoints are public and every browser is its own anonymous actor — `AnonymousActorResolver`: a random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS), the actor id `anon:<sha256 digest>` of it — so visitors never share threads, quota or attachments. A boot notice says the endpoints are public. `requestUserActorResolver(map?)` requires login in one line, reading `req.user` (Passport / cookie-session apps), `401` without it.
  - **Tools**: `@AiTool` `kind` defaults to `'read'` and `name` to the class name camelCased minus `Tool` (`GetWeatherTool` → `getWeather`); only `description` and `input` are required.
  - **Prompt**: module-level `systemPrompt` (string, or `(ctx) => string`) for the default agent and any `@Agent` without its own.
  - **Models**: `aiSdkModels({ id: model | { model, label, badges, … } }, { default })` from `@dudousxd/nestjs-agent-ai-sdk` returns a provider carrying `.catalog`, which `AgentModule` lists when `models` is omitted.

  **Breaking**

  - Tools no longer default to `['ADMIN']`: `DefaultRolesPolicy`'s default `defaultRoles` is `[]`, which restricts nobody — any resolved actor (anonymous included) can call a tool that names no `roles`. Explicit `@AiTool({ roles })`, `defaultRoles` and `rolesPolicy` still restrict. `action` tools still park on approval (by default the requester approves — for an anonymous visitor a confirmation, not an authorization). To keep the old behaviour: `AgentModule.forRoot({ defaultRoles: ['ADMIN'] })` (and `new AuthzRolesPolicy(gate, { fallbackRoles: ['ADMIN'] })`, whose fallback follows the same default).
  - `AgentModuleAsyncOptions.externalStore` is removed — a store module's `AGENT_STORE` is found automatically. `AGENT_STORE` is now always bound (and exported) by `AgentModule`.
  - `aiSdkModel`'s `resolveModel` option is removed, and a turn that picks a model the provider does not serve now fails instead of silently running on the bound model (a gateway id is no longer swapped for the pick). Use `aiSdkModels({ … })` for several models.
  - `@dudousxd/nestjs-agent-testing` requires `@dudousxd/nestjs-agent-core` `>=0.27.0`.

### Patch Changes

- Updated dependencies [[`cd2c790`](https://github.com/DavideCarvalho/nestjs-agent/commit/cd2c7909df1c88cc914ec6aa28940800e0dcd705)]:
  - @dudousxd/nestjs-agent-core@0.27.0

## 0.3.32

### Patch Changes

- Updated dependencies [[`50f76db`](https://github.com/DavideCarvalho/nestjs-agent/commit/50f76db3a7c283bdd576697578c449a4c5b7fcd2)]:
  - @dudousxd/nestjs-agent-core@0.26.0

## 0.3.31

### Patch Changes

- Updated dependencies [[`104c3a6`](https://github.com/DavideCarvalho/nestjs-agent/commit/104c3a6a0cc0cbf2d6b101fb648daa2565e1b856)]:
  - @dudousxd/nestjs-agent-core@0.25.0

## 0.3.30

### Patch Changes

- Updated dependencies [[`a4dc582`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4dc5823eea59e971404a53b4d7ce0fc7cda88b6)]:
  - @dudousxd/nestjs-agent-core@0.24.0

## 0.3.29

### Patch Changes

- Updated dependencies [[`75eb415`](https://github.com/DavideCarvalho/nestjs-agent/commit/75eb415c98cde1ba3fdd8d0366774c5d7514bfdf)]:
  - @dudousxd/nestjs-agent-core@0.23.0

## 0.3.28

### Patch Changes

- Updated dependencies [[`13b50e2`](https://github.com/DavideCarvalho/nestjs-agent/commit/13b50e24461194aec197e96b82bbee1afc4570c8)]:
  - @dudousxd/nestjs-agent-core@0.22.0

## 0.3.27

### Patch Changes

- Updated dependencies [[`26254d2`](https://github.com/DavideCarvalho/nestjs-agent/commit/26254d2020408e1712555d074a1814a9ba97b66c)]:
  - @dudousxd/nestjs-agent-core@0.21.0

## 0.3.26

### Patch Changes

- Updated dependencies [[`b410e83`](https://github.com/DavideCarvalho/nestjs-agent/commit/b410e836782605c13103ea3782e4146cb07aeefd)]:
  - @dudousxd/nestjs-agent-core@0.20.0

## 0.3.25

### Patch Changes

- Updated dependencies [[`b6edbab`](https://github.com/DavideCarvalho/nestjs-agent/commit/b6edbab8897179a87dce50e6ac45f90b91f4b91f)]:
  - @dudousxd/nestjs-agent-core@0.19.0

## 0.3.24

### Patch Changes

- Updated dependencies [[`70a3766`](https://github.com/DavideCarvalho/nestjs-agent/commit/70a3766ffa662392394c28f3336146cc157b7f96)]:
  - @dudousxd/nestjs-agent-core@0.18.0

## 0.3.23

### Patch Changes

- Updated dependencies [[`7e06e5a`](https://github.com/DavideCarvalho/nestjs-agent/commit/7e06e5ac9c3ec81732e3ff3b1714b627876097cd)]:
  - @dudousxd/nestjs-agent-core@0.17.0

## 0.3.22

### Patch Changes

- Updated dependencies [[`8a4ec35`](https://github.com/DavideCarvalho/nestjs-agent/commit/8a4ec35a9da5b697d71955a0a8437c810221e208)]:
  - @dudousxd/nestjs-agent-core@0.16.0

## 0.3.21

### Patch Changes

- Updated dependencies []:
  - @dudousxd/nestjs-agent-core@0.15.5

## 0.3.20

### Patch Changes

- Updated dependencies [[`3a3e75f`](https://github.com/DavideCarvalho/nestjs-agent/commit/3a3e75f6aa3b3efaaeb6235a0d4bb4048357458b)]:
  - @dudousxd/nestjs-agent-core@0.15.4

## 0.3.19

### Patch Changes

- Updated dependencies [[`df889d9`](https://github.com/DavideCarvalho/nestjs-agent/commit/df889d953f7d92ace46d22b1d33db2cdab88f7c2)]:
  - @dudousxd/nestjs-agent-core@0.15.3

## 0.3.18

### Patch Changes

- Updated dependencies [[`648fef6`](https://github.com/DavideCarvalho/nestjs-agent/commit/648fef61c336022ffb126ac15ab325387c05c49a)]:
  - @dudousxd/nestjs-agent-core@0.15.2

## 0.3.17

### Patch Changes

- Updated dependencies []:
  - @dudousxd/nestjs-agent-core@0.15.1

## 0.3.16

### Patch Changes

- Updated dependencies [[`3061f77`](https://github.com/DavideCarvalho/nestjs-agent/commit/3061f77548d48a8aa88b02eca46b04d24848646a)]:
  - @dudousxd/nestjs-agent-core@0.15.0

## 0.3.15

### Patch Changes

- Updated dependencies [[`d7f2cf2`](https://github.com/DavideCarvalho/nestjs-agent/commit/d7f2cf260ab0e87a012b21d681f805eb6758129a), [`31caa9e`](https://github.com/DavideCarvalho/nestjs-agent/commit/31caa9e48e9b8be948b54dd252057a01355f4924)]:
  - @dudousxd/nestjs-agent-core@0.14.0

## 0.3.14

### Patch Changes

- Updated dependencies [[`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4)]:
  - @dudousxd/nestjs-agent-core@0.13.0

## 0.3.13

### Patch Changes

- [`fe9fb99`](https://github.com/DavideCarvalho/nestjs-agent/commit/fe9fb9985131643ad9b2733a3c3658decdc585ab) - Add NestJS 12 to the supported peer range.

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

## 0.3.12

### Patch Changes

- Updated dependencies [[`70f3d57`](https://github.com/DavideCarvalho/nestjs-agent/commit/70f3d57dcebd9aec631adc66c40d0715472115d9)]:
  - @dudousxd/nestjs-agent-core@0.12.0

## 0.3.11

### Patch Changes

- Updated dependencies [[`7c27376`](https://github.com/DavideCarvalho/nestjs-agent/commit/7c273763eeb6d5841028612d81acc63b2a8dd4eb)]:
  - @dudousxd/nestjs-agent-core@0.11.0

## 0.3.10

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.3.9

### Patch Changes

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0

## 0.3.8

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.3.7

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.3.6

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

## 0.3.5

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0

## 0.3.4

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent-core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
