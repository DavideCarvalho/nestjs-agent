---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Add input and output processors — a seam on each side of the model call.

`PromptContributor` could append to the system prompt and nothing at all could look at the answer.
For an application that runs generated SQL over sensitive data that is a gap in the controls, not a
missing convenience: the one place where the model's output can still be stopped is between the
provider and the reader, and there was no such place.

`AgentModule.forRoot({ inputProcessors, outputProcessors })` (or `AgentLoopDeps` directly) adds both.
An `InputProcessor` rewrites `{ system, messages }` before every model call of a turn — every call,
not once per run, because the transcript grows between steps and a redactor that only saw the opening
prompt would wave through whatever a tool result carried back. An `OutputProcessor` sees each step's
answer and returns `pass`, `replace` (a redaction is a replacement), or `reject`, which ends the run
with an `OutputRejectedError` and an `output_rejected` stream error rather than an answer. Processors
are module-wide and apply to every agent: a control one persona can opt out of is not a control.

**They are not a second `HistoryPolicy`.** Selection — which of the thread's messages ride into the
turn — stays with `history`/`historyPolicy`, which is pure and runs outside any checkpoint.
Processors transform what selection produced, and run inside one, so they may call a model. The
loop's canonical transcript is untouched by them: a redaction is what leaves the process, never the
thread's own memory of what was said.

**Registering an output processor turns off live token streaming for the turn, and that is the
honest trade.** A gate that must read the whole answer cannot run after the answer has already
reached the reader. So the turn's model call writes to a buffer instead of the sink, and the loop
releases it — as one `text` frame — only once the chain has passed. The subscriber still gets step
boundaries and the turn's tool-call frames live; what it loses is token-by-token text, plus any
frame the gate cannot classify (a provider writing bare bytes rather than the `AgentStreamEvent`
vocabulary gets its text reconstructed from the gated answer, because forwarding bytes it cannot
read would not be a gate). Configure no output processor and the turn streams exactly as it always
did.

The buffer rides the `llm:<step>` CHECKPOINT rather than a local variable, and the release happens
inside the same `process:output:<step>` checkpoint that carries the verdict. Both matter under
durable replay: a run that suspends between the model call and the gate resumes in a process that
never saw the model's stream, and a release outside the verdict's checkpoint would flush the same
answer again on every replay. Under `dispatchedSteps: true` — the production default — the model
runs on another worker entirely, so `LlmStepEnvelope` carries a `bufferOutput` flag and
`AgentRunSteps.llm` hands the held frames back on its result. Without that, the gate would have been
bypassed on precisely the deployment that needs it.

A processor that throws surfaces as `ProcessorFailedError` naming the phase and the processor, so it
can never be read as the model call failing. A refused turn still records its `chat` usage row before
it fails: those tokens were genuinely spent, and a gate that hid its own cost could burn a budget
invisibly.

Nothing changes for a consumer who registers neither: the loop's checkpoint names and positions are
byte-identical, so a run already in flight keeps replaying.
