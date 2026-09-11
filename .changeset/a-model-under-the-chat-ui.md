---
'@dudousxd/nestjs-agent-react': minor
---

Give the chat components a model to render.

`MessageItem` and `MessageList` were style-agnostic, not headless: a `classNames` slot map and three
render props let you restyle the markup this package chose, but the markup was still this package's.
An app that wanted a different layout had to reimplement the logic those components hold — grouping
runs of consecutive tool parts, the edit-and-resubmit state machine, the copy-then-reset flash, the
windowed mount, the relative-time and cost/token derivations. The main consumer did exactly that,
and its 615-line message item lost `copy` and `fork` on the way, both of which shipped here already.

`useChatTranscript` is that logic with nothing drawn. It returns items whose parts are already
grouped into text / reasoning / tool **blocks**, each carrying its derived values (the copyable
prose, a usage summary with its labels, a described timestamp) and each action as a state machine
rather than a button: `item.copy.copied`, `item.edit.isEditing`/`draft`/`canSave`/`save()`,
`item.fork.run()`, `item.regenerate.available`. List-level state — the mounted window and its
`loadEarlier`, whether an empty state / typing indicator / follow-ups belong on screen, the stop
machine — sits on the instance. `useTranscriptItem` is the single-message half, for a host that
lays out the list itself. The model names no class and returns no node; where a value existed only
to feed a specific DOM shape, it stayed in the renderer.

This is additive. `MessageItem`, `MessageList` and `ChatInput` keep their props and their behaviour
exactly, and are now one rendering of the model — `MessageItemView` is that renderer, exported so a
host can drive the model itself and still get the default markup for a message. Every existing
component spec passes unchanged.

**Two capabilities the backend already paid for now reach the screen.** Reasoning frames have been
mapped to `reasoning-start`/`reasoning-end` chunks by `AgentChatTransport` since v7 support landed,
so reasoning parts were arriving on every `UIMessage` and no component looked at them; a reasoning
run is now a block of its own, open while it streams and folded once the answer lands, with
`renderReasoning`/`reasoningLabel` slots. And `POST /agent/chat/:runId/cancel` had no affordance
anywhere — `ChatInput` gains `onStop`/`isStreaming`, and the model exposes `stop.available` /
`stop.isStopping` so a host can render "Stopping…" for the gap between the click and the run
actually settling.

**Stick-to-bottom is model state, not a component behaviour.** `useStickToBottom` (also reachable as
`transcript.scroll`) follows the stream only while the reader is at the bottom, stops the moment they
scroll up, and says whether a "jump to latest" affordance is warranted — the bug where reading back
through a thread yanks the viewport away on every token, fixed once, for every renderer.

The package entry also drops its `export *` over the component barrel in favour of named re-exports.
A wildcard hides from a bundler which names a consumer actually uses, and has broken a downstream
build in this ecosystem before.
