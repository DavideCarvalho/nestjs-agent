---
"@dudousxd/nestjs-agent-core": patch
---

Sandbox kit fixes from the app rollouts:

- The prompt names theme variables as they exist in the frame (`var(--color-surface-secondary)`, not `var(--surface-secondary)`). The Tailwind utility (`bg-surface-secondary`) is listed separately.
- A stylesheet's imports are followed from its real path. A pnpm-injected workspace package's own imports (`shadcn/tailwind.css` and its variants) now reach the frame's Tailwind.
- The prompt asks for views at the frame's full width.
