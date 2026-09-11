---
'@dudousxd/nestjs-agent-react': minor
---

A file on a message is content, an unpriced turn is not a free one, and a message can carry a badge.

Three things a host had to reimplement the whole message item to get.

**Files were dropped on the floor.** `buildTranscriptBlocks` modelled text, reasoning and tool runs
and skipped everything else, so an attachment a user uploaded — which `POST /agent/attachments`
stages, the transport carries, and the model reads — rendered as nothing at all. The turn read as if
only the prose had been sent. Consecutive file parts now fold into a `files` block whose entries
carry `url`, `mediaType`, `filename` and `isImage`; `MessageItemView` shows images inline and links
anything else, and `renderFiles` takes the whole run for a host that wants a gallery or a viewer.
Files terminate a tool run and vice versa, because where a file sits in a turn is meaning: one
attached before the question reads differently from one the run produced after searching.

**`MessageUsageInfo.costUsd` is `number | null`.** A turn whose model has no row in the pricing
store has no cost, which is not the same fact as a turn that cost nothing — and `describeUsage`
was printing `$0` for both. `null` now renders as `—`. This widens the type, so a host already
supplying a number is unaffected; a host reading `costUsd` off the summary gets a null to handle,
which is the point.

**`meta` on the action row.** The row had a fixed set of affordances and no room for the one thing
that varies per message — which agent answered, what state it is in. `MessageItem` takes a `meta`
node, `MessageList` takes `getMeta(message)`, and both render it between the buttons and the usage
line. Without it, a multi-agent host had to fork the component to add a badge.
