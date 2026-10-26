---
"@dudousxd/nestjs-agent": patch
---

A durable turn's cancel check reads the run's own row instead of its detail. The check runs twice a
model step and only needs the run's status, but the detail carries every checkpoint of the run, and
an agent turn writes its whole prompt into a checkpoint once per model step: in a 20-turn
conversation of 8-step turns, the 20th turn read about 109 MB of checkpoints for these checks alone.
The row is read where the run gateway can read one (`getRun`); a gateway that can't still answers
through the detail.
