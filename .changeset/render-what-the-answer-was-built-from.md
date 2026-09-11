---
'@dudousxd/nestjs-agent-react': minor
---

Model the provenance behind an answer.

RAG has been persisting its retrieval since inject mode landed: the passages ride the assistant
message as an auto-executed tool call whose output is `{ passages }`, and `createRetrievalTool` does
the same for agentic search. Nothing in this package looked at it. A frontend saw an anonymous tool
part with a blob of text in it, so the one thing that makes a retrieved answer trustworthy — what it
was built from — reached the screen as a JSON dump or not at all.

`useChatTranscript({ sources: true })` lifts those parts into a `sources` block: origins aggregated
across the passages that share them, each with its passage count and best score, plus the query that
was searched. Detection is **structural** — a tool output shaped `{ passages: [{ id, text }] }` —
because the tool's name is not fixed: inject mode records `retrieve`, and `createRetrievalTool` lets
a host rename `search_knowledge` to anything. A view that matched on tool names would be wrong for
half the installations, and tool-name matching in a view is exactly the coupling the model exists to
absorb.

The option defaults to `false`, so a renderer already drawing tool cards keeps receiving retrieval as
the tool call it is. `MessageItem`, `MessageList` and `ChatInput` do not opt in, and their behaviour,
props and specs are unchanged.

Exported alongside it: `TranscriptSourcesBlock`, `TranscriptSource` and `RetrievedPassage`.
