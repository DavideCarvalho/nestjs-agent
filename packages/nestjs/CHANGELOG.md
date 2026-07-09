# @dudousxd/nestjs-agent

## 0.3.2

### Patch Changes

- Add a `GET <agentPath>/agents` catalog endpoint that lists the discovered
  `@Agent` classes (`{ name, description, isDefault? }`) from the `AgentRegistry`,
  so a frontend picker can source personas from the backend instead of hardcoding
  them. `@Agent({ description })` is now also carried through discovery onto the
  `AgentDefinition` (it was previously declared but dropped). `ActorResolver` is
  made generic over the request type (`ActorResolver<TReq = unknown>`) so hosts
  can implement it against their concrete request without an `unknown`-narrowing
  guard; the default type parameter keeps every existing call site source-compatible.
- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent-core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
