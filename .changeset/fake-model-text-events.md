---
"@dudousxd/nestjs-agent-testing": patch
---

`FakeModelProvider` now writes its scripted text to the sink as a `text` stream event (`encodeStreamEvent({ kind: 'text', text })`), the same frame `aiSdkModel` writes. Before, it wrote raw bytes, which a client such as `@dudousxd/nestjs-agent-react` couldn't decode, so a UI running against the fake showed no live text.
