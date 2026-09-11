---
'@dudousxd/nestjs-agent-react': patch
---

Stop a second turn from duplicating the first in the message list.

A running chat would fill its console with React's `Encountered two children with the same key`, and
the transcript would grow copies of the same two messages. The ids were the AI SDK's own, not the
store's, so nothing persisted was wrong — the live list was.

The mechanism is the SDK's push-or-replace test. It keeps one in-flight response per chat and, on
every write, decides whether that response's message replaces the list's last entry or is appended
by comparing the two ids — **only** against the last entry. One attempt at a time, that is exactly
right. Two attempts writing into the same chat alternate: A writes and is appended, B writes and is
appended, A writes again, finds B's message at the end, and is appended a second time. Four writes
in, the list holds two ids twice each, which is what the console was reporting.

Two things started a second attempt. React StrictMode runs the SDK's resume effect twice on mount,
so a chat with `resume`/`resumeRunId` opened two reconnects to the same buffered run and replayed
the same frames into the same list. And a composer that does not disable itself while busy could
send twice; the SDK does not survive that either, throwing `Cannot read properties of undefined`
from its own `finally` once the first attempt cleared the response the second was still using.

`AgentChatTransport` now admits one attempt at a time. A reconnect that arrives while one is live
resolves `null` — the SDK's own "nothing to resume", which costs it no state — and the latch is
released on every terminal path of the chunk stream. `useAgentChat`'s `sendMessage` and `regenerate`
refuse while a turn is in flight, because the SDK commits its response before a transport can see
the request, so that call has to be refused earlier than the transport can reach.

A model-level test now pins the invariant nothing asserted: a transcript's item ids are unique
across a stream that starts, settles, and is then resumed or raced.
