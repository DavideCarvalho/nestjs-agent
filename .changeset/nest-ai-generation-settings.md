---
"@dudousxd/nestjs-agent": patch
---

A turn on an `AiModule` model sends the same generation settings `@nestjs/ai`'s own calls send off a model's definition and `defaults`: `topP`, `topK`, `seed`, `stopSequences`, `presencePenalty` and `frequencyPenalty` as well as `maxOutputTokens`, `temperature`, `providerOptions` and `headers`. They were dropped before.
