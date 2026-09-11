---
'@dudousxd/nestjs-agent': patch
---

Answer an unidentified caller with 401, not 500.

`HeaderActorResolver` threw a plain `Error` when `x-actor-id` was absent. Nest has no mapping for
that, so the refusal reached the caller as `{"statusCode":500,"message":"Internal server error"}`
with a stack trace logged at ERROR — on a request that was merely unauthenticated. Every agent
route resolves the actor through this one call, so it applied to all of them.

Two costs. A client cannot tell "you did not authenticate" from "the server is broken", so the
correct client behaviour — get a token, retry — is indistinguishable from the one case where
retrying is wrong. And because anonymous requests are routine for anything reachable on a network,
each one wrote a stack trace, which is how a log stops being read.

It now throws `UnauthorizedException`. The message is unchanged and still refuses to fabricate an
identity or grant a default role.

**If you wrote your own `ActorResolver`,** throw `UnauthorizedException` (or any `HttpException`)
rather than a plain `Error` when you cannot identify the caller — the lib does not translate
arbitrary errors on your behalf, so a plain one produces the 500 described above.

The only behaviour change is the status code and the absence of the logged stack; nothing is
persisted for a refused caller, exactly as before.
