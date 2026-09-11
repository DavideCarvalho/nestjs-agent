---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Let an output processor declare that it can gate a prefix, so the turn keeps streaming.

Registering any output processor turned off live token streaming for every agent. That is the right
answer for a moderation pass that has to read the whole answer, and much too expensive for a regex
redactor that does not: on a live demo the same turn went from 66 streamed text frames to 1. The
module-wide SCOPE stays — a control a persona can opt out of is not a control — but the streaming
cost was welded to it, and now it is proportional to what the processor actually needs.

```ts
const redactEmails: OutputProcessor = {
  name: 'redact-emails',
  incremental: { lookbackChars: 320 },
  process: (answer) => ({ action: 'replace', text: answer.text.replace(EMAIL, '[email]') }),
};
```

**Undeclared still means whole-answer**, i.e. exactly today's behaviour, and a chain is incremental
only when EVERY member declares it. An author who wrote `process` against the complete text is never
downgraded because a neighbour opted in.

Declaring `incremental` is a promise about every prefix of the answer. The chain sees the growing
PREFIX rather than each new chunk, so it always gets well-formed text and "stable under chunking"
becomes a claim about prefixes: outside the last `lookbackChars` characters of its own output, a
`replace` never changes as the prefix grows. `lookbackChars` is per-processor (default 64) and the
gate uses the widest in the chain — an author who matches longer patterns says so, instead of a
library constant silently truncating one. A rejection promises to be decidable from a prefix; one
that only emerges from the whole answer still fails the run, but the reader has already seen text.
That is the cost of opting in, and it is documented rather than hidden.

**The whole-answer pass stays authoritative** for both the stream and the store — the incremental
release only emits its prefix early. The gate then asserts the settled answer `startsWith` what was
already released and raises `ProcessorFailedError` if not, so stream/store agreement is structural
rather than assumed, and a window too short for a pattern fails loudly instead of streaming the text
it was supposed to redact.

Determinism is unchanged. `process:output:<step>` keeps its name and position in all three modes, so
switching a declaration never moves a checkpoint. The released prefix rides the `llm:<step>`
checkpoint as `releasedText`, and the gate step reads WHICH release it still owes from that journaled
value rather than from the chain configured on whichever process resumed the run — so a run that
suspended under an incremental chain cannot flush the answer twice under a re-declared one. A refusal
reached from a prefix rides the same checkpoint as `gateRejection` and is raised only after
`persist:usage:<step>` and `quota:bump:<step>`: those tokens were spent, and a gate that hid its own
cost would let a mis-tuned chain burn a budget invisibly.

`hooks.dispatchLlm` (`dispatchedSteps: true`, the production default) falls back to full buffering.
The handler streams into a worker-side sink the loop cannot interpose on, so there is no prefix to
release; the envelope still asks for `bufferOutput` and the turn is held whole.

New in `-core`: `OutputProcessor.incremental`, `IncrementalGating`,
`DEFAULT_INCREMENTAL_LOOKBACK_CHARS`, `OutputGateMode`, `resolveOutputGateMode`,
`resolveGateLookback`, `createIncrementalGate`, `gateTail`, and
`BufferedModelTurnResult.releasedText` / `.gateRejection`. Register nothing, or nothing declared, and
the emitted stream and the journal are byte-identical to before.
