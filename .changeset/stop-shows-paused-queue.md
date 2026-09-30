---
'@dudousxd/nestjs-agent-react': patch
---

Stopping an answer with messages waiting behind it now shows the queue as paused right away. The server pauses the queue and says so on the run's stream, which the stop had just closed — so `chat.queue.paused` stayed `null` (and the waiting messages read "Up next") until the thread was loaded again. `cancel()` now reads the queue back (`getQueue`) when something is waiting.
