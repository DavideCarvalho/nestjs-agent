/**
 * `@dudousxd/nestjs-agent/a2ui` — A2UI (https://a2ui.org, v0.9) for the agent: the `a2uiAdapter()`
 * route (JSON Lines of A2UI messages), and the framework-free pieces it is built from (re-exported
 * from `@dudousxd/nestjs-agent-core/a2ui`) — the `ui` frame → A2UI converter, the builtin →
 * basic-catalog mappings, the catalog export, the inbound action reader. For A2UI over AG-UI, pass
 * `a2ui: true` to `agUiAdapter()`.
 */

export * from '@dudousxd/nestjs-agent-core/a2ui';
export { type A2uiAdapterOptions, A2uiRunHandler, a2uiAdapter } from './a2ui.adapter.js';
