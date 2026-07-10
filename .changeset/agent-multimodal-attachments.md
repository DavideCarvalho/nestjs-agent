---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent-ai-sdk": patch
"@dudousxd/nestjs-agent-store-mikro-orm": patch
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-react": patch
---

Carry image/PDF attachments through a chat turn so a vision-capable model sees them natively. A new
`MessageAttachment` (`{ mediaId, url, contentType, name }`) rides an optional `attachments` field on
`AgentRunInput`, `AppendMessageInput`, `StoredMessage`, and `ModelMessage`: the chat controller and
`AgentService` accept it, the loop persists it on the user message and replays it, the MikroORM store
round-trips it as a JSON column on `agent_message` (auto-added by the additive schema heal — no
migration), and the AI-SDK adapter renders a user message with attachments as native `image`/`file`
content parts (`image/*` → image, else file — Bedrock Claude reads a PDF this way). The React
transport forwards per-send attachments via the request body
(`sendMessage({ text }, { body: { attachments } })`).

All fields are optional, so text-only consumers are unaffected. The lib stays provider-agnostic: it
passes the attachment `url` straight through as the part's source — making that URL reachable by the
provider (presigned S3, a proxy) is the consumer's concern; the lib never fetches bytes or talks to a
store.
