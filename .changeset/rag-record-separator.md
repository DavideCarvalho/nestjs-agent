---
'@dudousxd/nestjs-agent-rag': minor
---

RAG chunking: `chunkText` can be told where the record boundaries are, so a table flattened to one record per row is never cut through the middle of a row.

Default chunking is structure-blind. It fills a `chunkSize` window and then breaks at the latest paragraph → sentence → word boundary inside it, which is a good rule for prose: the two halves are still sentences, and `overlap` carries the seam across. It is a bad rule for record-shaped text. A spreadsheet flattened to one field-labelled record per row (`MVR row 812 | Vehicle: 4A21810 | Odometer: 41233 | … | Fuel Type: DIESEL`) has boundaries that mean something, and the blind chunker does not know they exist — so a cut lands mid-record routinely, the half holding the row identifier and the half holding the value end up in different chunks, and **neither chunk can answer a question about that row**. Retrieval finds the identifier and returns a passage without the value, or finds the value and returns a passage that cannot be attributed to a row.

```ts
chunkText(text, { chunkSize: 800, separator: '\n' });
ingestDocuments(docs, { embedder, store, chunkSize: 800, separator: '\n' });
```

With `separator` set, whole records are packed greedily up to `chunkSize` and a record is never split — except one longer than `chunkSize`, which has nowhere to go and is character-split as usual. That fallback is confined to the single record that could not fit, rather than applied to the whole document, and it is the same splitting that would have happened anyway.

**`overlap` is ignored in this mode, deliberately.** Overlap exists to rescue a sentence that a boundary cut in half. A boundary that never falls inside a record has nothing to rescue, and carrying the tail of the previous chunk in would duplicate whole records into neighbouring chunks — paying for the same rows twice at embedding time and letting one row match from two places. Passing an `overlap` alongside a `separator` is not an error; it simply has no effect, and a test pins that.

What was measured: one 200-row, 15-column spreadsheet, flattened to one record per row and ingested **twice** into two collections — once with blind chunking, once with records kept whole. Same bytes, same embedder, same store, same questions, same `topK`; only the cut positions differed.

- Blind chunking left **27% of records split** (146/200 intact).
- On questions targeting a field on the *far side* of such a cut — the last columns, `Remarks` / `Fuel Type` — scored by requiring the row locator **and** the value in one retrieved chunk: BM25 answered **54/66 (MRR 0.818)** blind against **66/66 (MRR 1.000)** record-aware. Every failure was a `Remarks` question, the last field, which is exactly where the prediction said the cut would land.
- The dense leg scored **7/66 blind and 8/66 record-aware** (MRR 0.073 vs 0.061). 200 near-identical rows produce near-identical vectors, so that leg cannot do row lookup at all and chunking does not change it. The gain here is the lexical leg's, and only the lexical leg's.

The questions had to be built adversarially to show anything. An earlier, non-adversarial set — asking about `Odometer` on arbitrary rows — scored a perfect 1.000 on *both* arms, because the vehicle id is a rare exact token that BM25 finds whatever the chunking did to the row around it. So the honest claim is narrow: record-aware chunking fixes lookups whose answer sits far from the row's rare token, and changes nothing about the rest.

Additive and opt-in. With no `separator`, output is byte-identical to before — pinned by tests against the previous implementation's exact chunks.
