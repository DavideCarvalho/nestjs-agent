---
"@dudousxd/nestjs-agent-opencode": patch
---

A turn's `wallClockMs` limit no longer stops a turn a millisecond or so early. Timers can fire slightly before `Date.now()` says the time is up, so the stop could land (and `onStop` report an `elapsedMs`) just under the limit; an early timer now waits out the rest.
