---
'@dudousxd/nestjs-agent-core': minor
---

Show the structured-output pass the question and the answer, not the whole turn again.

The formatting pass was called with `[...prompt.messages, { role: 'assistant', content: turn.text }]`
— the entire selected transcript, tool outputs and all. It is one extra model call per turn, so
declaring an `outputSchema` roughly **doubled** what a turn cost: measured with core's own
`estimateMessageTokens`, a 30-turn thread with 8 KB tool outputs went from 64,826 tokens to 129,922
(+100%); a 10-turn thread of small outputs from 2,106 to 4,482 (+113%). Prompt caching does not
rescue it, because the pass swaps `system` for the structured-output instruction and the system
block is the cache prefix.

The pass is a translation of the answer, and its own instruction tells the model to use only what
the conversation already contains. It is now given what a translation needs: the question, and the
answer that survived the output gate. On a 10-turn thread with 8 KB outputs the extra pass falls
from ~21,400 tokens to 10, and the turn's total from 42,798 to 21,428.

The question comes off the **processed** prompt, not `AgentRunInput.userText`: the pass is a second
route out of the model and has to stand behind the same `inputProcessors` chain the streamed turn
did, so a question a processor masked cannot reappear in the clear here.

`AgentLoopDeps.outputFromTranscript` (default off) restores the old behaviour for an agent whose
answer genuinely cannot be restated from its own words — one that reports on rows a tool returned
and names only their total in the prose.

No checkpoint name or position changes: this is what is passed *inside* the already-journaled
`structured:<step>:<attempt>` step. The output chain still rules on each attempt before the schema
does, and a chain that rewrote the text still gets its version re-parsed rather than the provider's.
