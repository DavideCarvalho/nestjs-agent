---
'@dudousxd/nestjs-agent-core': patch
'@dudousxd/nestjs-agent-react': patch
---

A declined action reads as a decision, not as a malfunction

When a person pressed "Not now" on an action tool, the loop handed the model a tool result whose error text was the single word `rejected`. That names no actor and is indistinguishable from a tool that threw, so the answer that followed diagnosed the refusal — "the key may not exist", "there may be permission restrictions", "the cache system may have rejected it for another reason" — and offered to retry the same action, asking the person to say no twice.

The same word went out on the `tool-output-error` frame, so a client drew the refusal with the treatment a crash gets. And a reloaded thread was worse: the stored result mapped to `output-available`, which reads as a completed call, so after a refresh the action a person had refused was shown as one that had been carried out.

- `ToolResult` gains `denied?: true`. It is set instead of a failure and read by everything that has to tell the two apart; `error` still carries what the model is told, because that is the channel a model reads an outcome on.
- The model-facing text now says who decided, that nothing ran, and what not to do next — do not explain it as an error, do not guess at causes, do not retry or reach for another way to do the same thing. A reason given when declining is included.
- New `tool-output-denied` stream frame, mapped by the React transport onto the SDK's `output-denied` tool part state.
- `storedMessageToUiMessage` reloads a declined call as `output-denied`, including for threads written before the `denied` flag existed.
