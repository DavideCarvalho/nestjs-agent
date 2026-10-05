# Component registry and server rendering implementation plan

> **For agentic workers:** Use subagent-driven-development for independently owned packages and review completed work against the approved spec.

**Goal:** Ship one typed component/presentation contract for Adonis and Aviary, with per-app registries and optional React server rendering.

**Architecture:** Extend Aviary core GenUI and React adapters. Adonis re-exports the shared implementation and adds its own tool authoring integration. Tool presentations travel through existing journaled UI emissions, and server capture is a separate optional transport-independent module.

**Tech Stack:** TypeScript, Standard Schema, existing GenUI JSON Schema validation, ReactDOM server, optional Playwright capture, Vitest, pnpm.

## Task 1: Shared registry and authoring

Files: `packages/core/src/genui/presentation.ts`, `registry.ts`, `index.ts`, `packages/core/src/spi/tool.ts`, `tool-registry.ts`, `packages/nestjs/src/functional-tool.ts`, and adjacent specs.

- [x] Write failing consumer tests: `const Custom=createComponent({...}); const result=await Custom(props); await registry.register(Custom.definition,{text:props=>props.label}).render(result,'text')`.
- [x] Run `pnpm exec vitest run packages/core/src/genui packages/core/src/tool-registry.spec.ts packages/nestjs/src/functional-tool.spec.ts`; establish missing API failures.
- [x] Implement typed validated factories, server renderer registry with manifest/catalog, table/chart helpers, and safe present hook execution through emitUi.
- [x] Preserve old defineTool/provideAgentTool signatures; add object authoring form with input/result inference.
- [x] Test permission denial, preflight completion, this binding, preserved raw output and failed presentation without duplicate execution.
- [x] Run unit suites/typecheck/build and commit.

## Task 2: React server rendering

Files: `packages/react/src/genui/server/*`, `packages/react/package.json`, `tsup.config.ts`, adjacent specs.

- [x] Write failing tests for `createReactServerRenderer` using custom components, invalid props and an HTML-like user string.
- [x] Run the new tests and establish missing renderer failures.
- [x] Implement HTML rendering with validated schema/version, escaped theme/attributes, trusted inline CSS or stylesheet path, and plain table pagination.
- [x] Implement capture port and optional Playwright adapter with fonts/images readiness, timeout/size bounds, network policy and page cleanup.
- [x] Verify PNG/PDF signatures with a real local browser and all records present in paginated HTML; inspect PNG.
- [x] Add package exports/optional peers, documentation and changeset; run React typecheck/build.

## Task 3: Adonis integration

Files: `packages/adonis/src/spi/tool.ts`, `tool-registry.ts`, `ai-tool-ref.ts`, `src/react/genui/server.ts`, `package.json`, `test/tool-present.spec.ts`, docs.

- [x] Write failing class and functional-tool tests for `present`; run Vitest and establish missing emissions.
- [x] Implement equivalent hooks/object form without mandatory core imports in the root entry; shared helpers live in existing optional GenUI entry.
- [x] Re-export the shared server renderer in `@adonis-agora/agent/react/genui/server`; validate against freshly built local Aviary packages without publishing unreviewed code.
- [x] Add docs and changeset; run focused tests, typechecks and production build.

## Task 4: Review and publication

- [x] Review spec compliance, then code quality, especially execution replay safety and SSR/browser separation.
- [x] Fix findings, rerun affected checks and record evidence.
- [x] Commit both branches and create/link draft PRs in the two library repositories. Do not claim npm release or app deployment until it actually occurs.

## Verification evidence

Core/Nest: 145 files / 1301 tests passed. React GenUI: 32 tests passed, including Chromium PNG/PDF capture and a two-page PDF. Adonis: 109 focused tests passed; production and test TypeScript checks, repository lint, and production build passed against the freshly built local Aviary peers. Independent final review: 48 additional focused tests passed with no unresolved critical issues. Adonis draft PR publication must follow the Aviary core/React release because its SSR re-export requires the new peer exports. Existing Adonis lint warnings in unrelated files were left unchanged.

PRs: Aviary https://github.com/DavideCarvalho/nestjs-agent/pull/307; Adonis https://github.com/DavideCarvalho/adonis-agora-agent/pull/300. Both registered with the T3 thread; no npm release or application deployment performed.
