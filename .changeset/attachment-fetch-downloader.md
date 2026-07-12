---
'@dudousxd/nestjs-agent-ai-sdk': minor
---

`attachmentFetchDownloader()` — the ready-made `experimental_download` for hosts whose attachment
staging presigns non-public URLs (local MinIO in dev, VPC-only S3): plain-fetches unsupported URLs
with no hostname policy, leaves model-supported URLs to the provider, errors carry status +
hostname (never the full presigned URL). One line instead of the fetch boilerplate every such host
was about to copy. Safe only because agent attachment URLs come from the host's own staging SPI.
