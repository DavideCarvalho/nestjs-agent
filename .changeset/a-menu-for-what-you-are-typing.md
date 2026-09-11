---
'@dudousxd/nestjs-agent-react': minor
---

Give the composer a completion menu, and give it no opinion about what it completes.

Typing `/` now opens a filtered, keyboard-driven list that inserts what you pick.
`useComposerAutocomplete` is that as a model: which trigger the caret is inside, the query, the
items, the highlight, whether a source is still answering, and what accepting one does to the text
and the caret. It renders nothing.

It is source-agnostic on purpose. A host supplies sources, each with a trigger character and a
`getItems`, so `@` to mention an agent or a thread is another entry in the array rather than a
second component. Skills — the immediate use — are one source like any other; nothing in the
composer knows what a skill is.

**The trigger rule is per source and has no default.** `position: 'start'` fires only as the first
character of the input, which is what a slash command wants: `/deploy` is a command, `src/foo` and
`and/or` are not. `position: 'word'` fires at the start of any word, which is what a mention wants:
`@ada` mid-sentence is a mention, `ada@example` is an address. Getting this wrong breaks the case
people type most, so the source states it rather than inheriting a guess.

Accepting replaces the token, keeps the trigger and appends a space — `/roll` + *rollback* →
`/rollback ` with the caret after it — and leaves anything to the right of the caret where it was.
The space closes the menu, so typing on is free text; `insertSuffix: ''` opts out. ↑/↓ move and
wrap, Enter and Tab accept, Escape closes for that token, Shift+Tab still moves focus. Every key the
menu takes is `preventDefault`ed, which is how a composer that sends on Enter knows to stand down.

An async source is asked per query with an `AbortSignal`. An answer to a query the user has already
typed past is discarded instead of overwriting a newer list, and the request behind it is aborted; a
source that throws reports itself in the menu and leaves typing and sending alone.

Skills are the first source, and nothing about them is special-cased. `createSkillsSource` reads
`GET /agent/skills` — the scope-resolved list of what this actor can invoke, built by the same call
that offers the catalog to the model, so what a user can type after a `/` and what the agent can
reach cannot drift apart — once per thread rather than once per keystroke, since the endpoint
answers with the whole list and the narrowing is local. Every row shows where its skill came from,
and says `overrides` when one shadows another — `shadows` is set only on a clash, so "there is no org
default" and "there is one and yours wins" do not read the same. The received order is the
precedence and is left alone. `AgentClient` gains the matching `listSkills`.

An empty menu says which kind of empty it is: "Nothing to complete" when a source offered nothing at
all, "No matches" when a query matched none of what it offered.

It is a combobox, wired as one: `getInputProps` puts `role`, `aria-expanded`, `aria-controls` and
`aria-activedescendant` on the textarea, and `getListboxProps`/`getOptionProps` put `listbox`/
`option` and the ids they point at on the list.

In the shadcn registry, `ChatComposer` gains `autocompleteSources` and wires all of it, and
`ChatCommandPalette` grows into the popup half rather than a second palette appearing beside it —
handed the prop-getters its rows become `option`s and stop being focus stops, so focus never leaves
the composer mid-query, and its `↑↓ navigate · Enter select · Esc` hint row finally describes keys
that work. Handed `suggestions` as before, it behaves exactly as before.
