# Type-checking the specs

`pnpm typecheck` does not look at a single `*.spec.ts` file. Every package's `tsconfig.json` is the
one the build emits from, so it excludes specs — otherwise they would land in `dist`. The exclusion
is correct; the consequence was not. A type error in a spec compiled fine, ran fine under Vitest
(which strips types rather than checking them), and was invisible to CI forever.

That is not hypothetical. Enabling this check found a spec setting `summaryMessageCount` on
`AgentThread` — a property that entity has never had. MikroORM's `em.create` silently dropped it, the
test passed, and the field looked load-bearing to anyone reading the spec.

`pnpm typecheck:specs` is the same check with specs included, `noEmit`, per package via
`tsconfig.spec.json`. It runs in CI right after `pnpm typecheck`.

## Opting a package in

Packages opt in one at a time, because the backlog is real. At the time this was introduced,
running it across the whole monorepo reported **194 errors in 10 packages**:

| package | errors |
|---|---|
| core | 67 |
| react | 34 |
| codegen | 32 |
| store-drizzle | 30 |
| dashboard | 15 |
| nestjs | 6 |
| store-mikro-orm | 4 → fixed |
| ai-sdk | 3 |
| data | 2 |
| rag-media | 1 → fixed |
| rag | 0 |

Turning it on repo-wide in one commit would have meant blind-fixing 194 errors across packages in a
single change, which is how you turn a real check into a rubber stamp. So `rag`, `rag-media` and
`store-mikro-orm` are in; the rest is a standing invitation.

To add a package:

1. Create `packages/<name>/tsconfig.spec.json`:

   ```json
   {
     "$schema": "https://json.schemastore.org/tsconfig",
     "extends": "./tsconfig.json",
     "compilerOptions": { "noEmit": true, "types": ["node"] },
     "include": ["src/**/*.ts"],
     "exclude": ["dist", "node_modules"]
   }
   ```

2. Add `"typecheck:specs": "tsc -p tsconfig.spec.json"` to its `package.json` scripts. Turbo picks
   up any package that defines the script — no root wiring needed.
3. Fix what it reports. Prefer fixing the spec over loosening the config: most of these are a spec
   asserting against a shape the code does not actually have, which is exactly the class of bug this
   check exists to surface.

## Verifying the gate still bites

A check nobody has seen fail is a check nobody should trust. Append a deliberate error to any
covered spec and confirm `pnpm typecheck:specs` reports it:

```
src/rag.spec.ts(308,7): error TS2322: Type 'string' is not assignable to type 'number'.
 Tasks:    6 successful, 8 total
```
