---
"@dudousxd/nestjs-agent-react": patch
---

Fix a stale symbol reference in the `storedThreadToUiMessages` docblock

The note explaining why `{type: 'step-start'}` parts are not reproduced pointed at
`MessageItem`'s `renderParts`, which exists nowhere in the repo — the function is
`renderBlocks` in `components/message-item.tsx`. The same sentence also claimed it
"only special-cases text and tool parts", while `renderBlocks` branches on four block
kinds: text, reasoning, files and tools.

Comment-only; no runtime change.
