---
'@dudousxd/nestjs-agent-rag-media': patch
---

`MimeTextExtractor` now normalizes registration keys the same way it already normalized lookups: media type only (the part before the first `;` per RFC 2045), trimmed and lowercased. Previously only the query side did this, so `.register('TEXT/*', fn)` and `.register('application/csv; charset=utf-8', fn)` stored a key that no normalized lookup could ever hit — a dead extractor that reports itself as an unsupported type, which ingestion records as a *skip*. The caller's own registration silently vanished and the documents disappeared with no error surfaced to the operator. The normalization rule is now a single exported helper, `normalizeMimeType`, shared by both sides so they can't drift apart again.
