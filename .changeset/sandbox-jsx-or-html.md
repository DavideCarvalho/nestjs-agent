---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent-react": patch
---

Sandbox views a real model writes under strict tool calling (it fills every field):

- The schema offers `jsx` only when the kit has a bundle to draw it with. A stylesheet-only kit is written as `html`.
- When a model writes both `html` and `jsx`, the longer one wins (`sandboxDrawsJsx`, in the web and React Native renderers). A stub `App` next to the real `html` no longer blanks the frame.
- The JSX rules now say "jsx OR html, never both".
