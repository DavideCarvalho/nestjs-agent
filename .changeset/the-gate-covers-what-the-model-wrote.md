---
'@dudousxd/nestjs-agent-core': minor
---

Put the structured pass and the follow-ups through the output gate.

Output processors are presented as the place a model's output can still be stopped, and a reader
reasonably assumes the gate covers everything a model wrote. It covered the streamed answer only.
Three model-generated values never entered `runOutputProcessors`, and one of them is a real hole: the
`outputSchema` formatting pass restates the finished answer into a schema via its own `runTurn` into
a discard sink, and its validated object is persisted on the assistant message and pushed to the
client as a `tool-output` frame. A model can restate anything the chain held back into a field, and
it went out ungated.

**The structured pass is now gated, before validation.** The chain runs over each attempt's restated
text at `process:output:structured:<step>:<attempt>`, and what the schema validates — and what is
persisted and streamed — is the gated version. Where the chain rewrote the text, a provider-reported
parsed `object` is discarded and the gated text re-parsed: that object describes the answer the gate
just changed, and trusting it would hand the reader exactly what was removed. A rejection fails the
run with `OutputRejectedError`, as on the prose.

**Each follow-up suggestion is now gated**, one at a time, at `process:output:followups:<step>` — so a
refusal is confined to the one that earned it and a `replace` cannot smear across a neighbour. A
refused suggestion is **dropped**, not a failed run: follow-ups are generated after the turn's answer
has already cleared the same chain, and retracting a cleared answer because a question nobody asked
for was refused would make a run's outcome depend on a by-product. Dropping removes it just as
completely, which is what the refusal was for. `gateFollowUps` is exported.

**The folded history summary is deliberately NOT gated, and this documents why.** It never reaches a
reader — it re-enters the next prompt as a leading `system` message, which makes it input, and the
input seam already owns it: `inputProcessors` see the summary on every step of every turn that
carries one, because it is part of `prompt.messages`. Running answer-shaped controls over prompt text
would apply a contract the processor's author never agreed to, and the seam that does apply is
already there.

**Neither new pass is streamed**, so an `incremental` declaration buys nothing on them — there is no
prefix to release, and both always run the whole-answer pass whatever the chain declared. Both
checkpoints are reachable only when an output chain is registered *and* the feature they gate is
configured, and each sits immediately after the usage row for the call it rules on, so a refusal can
never hide the tokens it already spent.
