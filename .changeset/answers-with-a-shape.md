---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-ai-sdk': minor
---

Constrain a turn's answer to a schema.

Every answer this library produced was free text, so the only way to get a typed value back out of a
turn was to declare a TOOL whose whole job was to receive it — which is how the main consumer ended
up with a `renderResult` tool that renders nothing and exists purely to smuggle structure past the
prose.

`@Agent({ outputSchema })` takes any [Standard Schema](https://standardschema.dev) (Zod, Valibot,
ArkType). The validated value comes back as `object` on the run's result, typed when the loop is
called directly (`runAgentLoop<T>`), and is recorded on the assistant message as a synthetic
`structured_output` tool call — the device inject-mode retrieval already uses, so it reaches every
thread reader and the UI's existing tool-output rendering without a store gaining a column. It is
declared on the agent rather than per request because a schema is a live object and `AgentRunInput`
crosses a JSON boundary on its way into a durable workflow.

**How it composes with tool calling: as a separate formatting pass, always.** The turn runs its
model→tools iteration exactly as it would without a schema; once a step comes back with no tool
calls, one extra non-streamed call (`structured:<step>:<n>`, `tools: []`, `outputSchema` set)
restates that answer as the schema. Most providers cannot serve a response format and a tool set in
the same request. Skipping the pass for an agent that happens to have no tools would be cheaper and
is deliberately not done: that decision would read the tool registry of whichever process is
replaying, which is how a resumed run ends up asking for a checkpoint position its history has no
room for. So the pass is unconditional, and it costs one model call per turn, billed as its own
`structured_output` usage row.

The pass restates the answer that survived the output gate, never the model's raw reply, and is told
to use only what the conversation already contains — the structured value is a translation of the
answer, not a second route out of the model.

**An answer that fails the schema is a defined outcome.** Up to `outputRepairAttempts` further calls
(default 1) re-ask with the previous attempt's validation issues attached; after that the run fails
with a `StructuredOutputError` carrying the issues, the text that failed them, and the attempt count,
under its own `structured_output_invalid` stream error code. Bounded because a model that cannot
satisfy a schema usually cannot satisfy it on the fourth try either, and every attempt is billed. Set
`outputRepairAttempts: 0` to fail on the first invalid reply.

`ModelTurnArgs` gains `outputSchema` and `ModelTurnResult` gains `object`. The AI SDK adapter maps
the schema onto `streamText`'s `output: Output.object(...)` so the provider constrains generation,
and passes its parsed value back — but the loop validates it regardless. "The provider says it
matched" is not the same claim as "it matches", and a provider that ignored the schema has to fail
where the failure is repairable rather than downstream. An adapter that cannot constrain generation
at all still works: the loop reads the JSON out of the reply text, fences and lead-in prose included.

`UsagePurpose` gains `'structured_output'`. Both shipped stores persist `purpose` as text, so no
schema change is needed. A consumer who declares no `outputSchema` sees no new checkpoint, no extra
call, and no change to the loop's checkpoint sequence.
