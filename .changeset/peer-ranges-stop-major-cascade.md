---
'@dudousxd/nestjs-agent-ai-sdk': patch
'@dudousxd/nestjs-agent-rag': patch
'@dudousxd/nestjs-agent-store-mikro-orm': patch
'@dudousxd/nestjs-agent-testing': patch
'@dudousxd/nestjs-agent-transport-redis': patch
---

Stop a `core` minor from promoting half the monorepo to 1.0.0.

Five packages declared their peer dependency on `@dudousxd/nestjs-agent-core` as `workspace:*`. Changesets treats a peer-dependency bump as breaking for the dependent, and "breaking" on a `0.x` package means `1.0.0` — so the moment `core` took a minor, `ai-sdk`, `rag`, `store-mikro-orm`, `testing` and `transport-redis` were all queued to publish as `1.0.0`. `rag-media` went with them by cascade: its own range on `core` was correct, but its `>=0.4.0 <1.0.0` on `rag` stopped being satisfied once `rag` majored.

The ranges are now `>=0.10.0 <1.0.0`, matching what `dashboard` and `rag-media` already declared. `onlyUpdatePeerDependentsWhenOutOfRange` is already set in the changesets config, and with a range that a `0.11.0` core still satisfies it does its job. `dashboard` is the control: it peer-depends on `core` too, and it was the one package that did *not* major, because its range was written this way from the start.

Verified by running `changeset version` against the same set of changesets before and after: six `1.0.0` bumps become the minors and patches those changesets actually asked for.

Consumers would have felt this as silence rather than breakage. A dependant on `^0.7.0` of `rag` does not match `1.0.0`, so it simply stops receiving updates, with nothing failing anywhere to say so.
