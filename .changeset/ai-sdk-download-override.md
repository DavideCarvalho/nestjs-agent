---
'@dudousxd/nestjs-agent-ai-sdk': patch
---

`AiSdkModelOptions` accepts `experimental_download` — the AI SDK's default downloader refuses
localhost/private hostnames (SSRF guard), so attachment parts staged against a local object store
(MinIO in dev) killed the model call with `AI_DownloadError: URL with hostname localhost is not
allowed`. Hosts whose staging presigns non-public URLs supply their own fetch; attachment URLs come
from the host's own staging SPI, never user input.
