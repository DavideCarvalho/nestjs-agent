# Component registry and server rendering implementation plan

> **For agentic workers:** Use subagent-driven-development for independently owned packages and review completed work against the approved spec.

**Goal:** Ship compatible typed component/presentation contracts for Agora and Aviary, with independently owned implementations, per-app registries and optional React server rendering.

**Architecture:** Extend Aviary core GenUI and React adapters within Aviary. Agora owns its GenUI, React/SSR, AG-UI and media implementations within its repository. Preserve compatible public APIs and the existing wire protocol without cross-ecosystem imports, re-exports, dependencies, shared source packages or symlinks. Each library builds, tests and releases independently. Tool presentations travel through existing journaled UI emissions, and server capture is a separate optional transport-independent module.

**Tech Stack:** TypeScript, Standard Schema, existing GenUI JSON Schema validation, ReactDOM server, optional Playwright capture, Vitest, pnpm.

## Task 1: Aviary registry and authoring

Files: `packages/core/src/genui/registry.ts`, `index.ts`, `packages/core/src/spi/tool.ts`, `tool-registry.ts`, `packages/nestjs/src/functional-tool.ts`, and adjacent specs.

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

## Task 3: Independent Agora implementation

Files in the Agora repository: `packages/adonis/src/genui/*`, `src/react/core/*`, `src/react/genui/*`, `src/ag-ui/core/*`, `src/spi/tool.ts`, `src/tool-registry.ts`, `src/ai-tool-ref.ts`, `package.json`, consumer and independence tests, docs.

- [x] Write failing class and functional-tool tests for `present`; run Vitest and establish missing emissions.
- [x] Implement equivalent hooks/object form using Agora’s own contracts and journaled emissions.
- [x] Replace former Aviary re-exports with owned GenUI, React/SSR, AG-UI and media implementations; retain the existing Agora export paths and configuration APIs.
- [x] Remove Aviary peers and dependencies from Agora; no linked Aviary checkout is needed to run consumers.
- [x] Validate all affected exports using an isolated consumer without any Aviary package installed.
- [x] Add docs and changeset; run focused tests, typechecks and production build.

## Task 4: Review and publication

- [x] Review spec compliance, then code quality, especially execution replay safety and SSR/browser separation.
- [x] Fix findings, rerun affected checks and record evidence.
- [x] Commit both branches and create/link draft PRs in the two library repositories. Do not claim npm release or app deployment until it actually occurs.

## Independence validation

- [x] Verify Aviary manifests and production source declare no Agora dependencies or imports/re-exports; add an AST-based regression guard.
- [x] Verify local Agora GenUI definitions, registry, transformations, generated tools and browser-safe imports using 78 focused tests.
- [x] Complete Agora React/AG-UI/media architecture guards, consumer checks, typechecks, lint and production build after the full independent port.
- [x] Run final affected suites and real-browser PNG/PDF capture for both libraries, and record final independent-release evidence.

## Historical verification before the independence correction

The following evidence predates the user’s correction requiring fully independent libraries. It records the former implementation and does not certify the current independent Agora port.

Core/Nest: 145 files / 1301 tests passed. React GenUI: 32 tests passed, including Chromium PNG/PDF capture and a two-page PDF. Adonis: 109 focused tests passed; production and test TypeScript checks, repository lint, and production build passed against the freshly built local Aviary peers. Independent final review: 48 additional focused tests passed with no unresolved critical issues. The former Adonis implementation used Aviary peer re-exports; that architecture has been removed. There is no release ordering requirement between the corrected independent libraries. Existing Adonis lint warnings in unrelated files were left unchanged.

PRs: Aviary https://github.com/DavideCarvalho/nestjs-agent/pull/307; Adonis https://github.com/DavideCarvalho/adonis-agora-agent/pull/300. Both registered with the T3 thread; no npm release or application deployment performed.

## Final independent verification

Agora: the complete SQLite project passed 205 files / 2,180 tests, with 4 files / 89 cases skipped by existing environment/compatibility gates. Production and test typechecks, frozen lockfile installation, repository lint (three pre-existing warnings) and the three-task monorepo production build passed. Real Chromium capture verified PNG, a two-page PDF and caller browser cleanup. Its packed package installed in a new consumer directory with no Aviary package in the lockfile; React, GenUI, SSR, capture, media and AG-UI imports worked, and SSR escaping plus AG-UI encoding passed. A browser build resolved 164 modules with no server root or Aviary dependency.

Aviary: 109 focused GenUI/registry/React/independence tests passed, followed by a passing real Chromium PNG/PDF capture. Core production/spec and React production typechecks and React ESM/CJS/declaration builds passed. The independent architecture guard covers every production package and dependency manifest. Final independent review ran another 35 focused cases and the packed-consumer smoke test, with no new blockers.

The existing optional skills-maintenance CI job failed because its external OpenCode provider requires an active subscription. This is unrelated to package compilation; shipped consumer skills were updated and validated locally. No npm release or application deployment was performed.
