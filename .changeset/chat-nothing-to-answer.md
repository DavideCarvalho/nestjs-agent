---
'@dudousxd/nestjs-agent': patch
---

A send with nothing to answer is refused up front. `POST <agent path>/chat` with `{}` (or a blank message) answered `201` and started a run that crashed on the missing text (`undefined.trim()`, or the provider's "text field is blank"). `AgentService.send` now checks the message before a text decision, the quota or a thread: no non-blank `message`, no attachment and no `regenerate` is `400 { code: 'no_user_message' }` (exported as `NO_USER_MESSAGE_CODE`), and a non-string `message` is `400 invalid_message`. Nothing is created or queued. This covers the HTTP route, `chat()`, `send()` and the queue. An attachment-only send now runs with an empty text instead of an undefined one, and the AG-UI route (which already answered `no_user_message`) now accepts a `regenerate` whose user message is empty, as `chat` does.
