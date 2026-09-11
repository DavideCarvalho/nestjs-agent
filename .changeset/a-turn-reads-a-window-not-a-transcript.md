---
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

Read the window a turn sends, not the thread's whole transcript.

A turn loads the thread to build its prompt, and loaded it with `getThread`: every message row, every
attachment, every tool output the thread ever recorded, all of it parsed — and then journaled, so a
resumed run re-reads and re-parses the same payload. On a 50-turn thread whose turns each ran a 50 KB
tool that is **1.9 MB per load, 97% of it tool results**, to send a prompt bounded to the last few
messages.

Both SQL stores gain `loadThreadForTurn({ threadId, messageLimit })`, returning the thread's newest
`messageLimit` messages oldest-first, its title, its default agent, and whether the thread has ever
been answered. The read is the database's job: `order by created_at desc limit ?` over the columns a
model turn reads (`usage`, `follow_ups` and `run_id` stay in the table), reversed for the prompt.
`messageLimit: 0` reads no messages at all rather than every one of them; an omitted `messageLimit`
reads the whole thread.

`hasAssistantMessage` is answered over the WHOLE thread — a one-row probe, not a scan of the page.
It is what a thread-start intake asks ("has this conversation been answered before?"), and a long
thread whose window happens to hold only the user's last questions has still been answered; computed
off the page, such a thread re-introduces itself on every turn.

The method is probed structurally rather than added to the `AgentStore` SPI, the same way
`defaultAgentForThread` is: it is an optimization a store either offers or does not, and a store that
predates it still answers correctly through the full `getThread` read.

**Upgrading.** Nothing to run: additive method, no schema change, no behaviour change for any
existing call. `getThread` still returns the full `ThreadDetail` and is still the right read for a
client rendering a transcript.
