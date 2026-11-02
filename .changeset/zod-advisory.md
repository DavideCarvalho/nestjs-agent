---
'@dudousxd/nestjs-agent': patch
'@dudousxd/nestjs-agent-data': patch
---

Depend on `zod` `^4.6.6` instead of `3.25.76`, which GHSA-mrhx-c7xc-m3w5 covers (`zod` before 4.6.6; no 3.x is patched). Your own tools can stay on Zod 3 or use Zod 4. If your app keeps Zod 3, the AI SDK converts this library's built-in tool schemas with its own older converter, so the `executeSql` input loses its `description` and `minLength` in the JSON Schema the model sees. The input is still validated.
