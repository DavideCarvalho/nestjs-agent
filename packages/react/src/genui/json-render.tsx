/**
 * Optional json-render adapter for tree frames (`@dudousxd/nestjs-agent-react/genui/json-render`).
 * Needs the optional peer `@json-render/react` (>= 0.21). Use it when your app already renders
 * json-render specs and wants tree frames to go through the same `Renderer` (its state, actions and
 * visibility machinery); otherwise `<GenerativeUI>` renders trees natively.
 *
 * ```tsx
 * const registry = { ...myComponents, [GENUI_TREE_COMPONENT]: jsonRenderTree(myJsonRenderRegistry) };
 * ```
 */
import { type ComponentRegistry, JSONUIProvider, Renderer } from '@json-render/react';
import { type ReactNode, useMemo } from 'react';
import type { GenerativeUIElement, GenuiRegistry, GenuiRenderer } from './types.js';

/** A json-render flat spec: `{ root, elements: { [id]: { type, props, children } } }`. */
export interface JsonRenderFlatSpec {
  root: string;
  elements: Record<string, { type: string; props: Record<string, unknown>; children: string[] }>;
}

/** A tree frame's `root` as a json-render flat spec (ids `el-0`, `el-1`, … depth first). */
export function treeToJsonRenderSpec(root: GenerativeUIElement): JsonRenderFlatSpec {
  const elements: JsonRenderFlatSpec['elements'] = {};
  let next = 0;
  const visit = (node: GenerativeUIElement): string => {
    const id = `el-${next++}`;
    const entry = { type: node.type, props: node.props ?? {}, children: [] as string[] };
    elements[id] = entry;
    for (const child of node.children ?? []) entry.children.push(visit(child));
    return id;
  };
  return { root: visit(root), elements };
}

/**
 * Adapt a genui registry (renderers taking props + `children`) to a json-render registry (renderers
 * taking `{ element, children }`), so one set of components serves both.
 */
export function toJsonRenderRegistry(registry: GenuiRegistry): ComponentRegistry {
  return Object.fromEntries(
    Object.entries(registry).map(([name, Renderer]) => [
      name,
      ({ element, children }: { element: { props?: unknown }; children?: ReactNode }) => (
        <Renderer {...((element.props ?? {}) as Record<string, unknown>)}>{children}</Renderer>
      ),
    ]),
  );
}

export interface JsonRenderTreeProps {
  root?: GenerativeUIElement;
  registry: ComponentRegistry;
  /** json-render state the spec's `$state` expressions read. */
  initialState?: Record<string, unknown>;
}

/** Render a tree frame's `root` with json-render. */
export function JsonRenderTree({ root, registry, initialState }: JsonRenderTreeProps) {
  const spec = useMemo(() => (root === undefined ? null : treeToJsonRenderSpec(root)), [root]);
  if (spec === null) return null;
  return (
    <JSONUIProvider registry={registry} {...(initialState !== undefined ? { initialState } : {})}>
      <Renderer spec={spec as never} registry={registry} />
    </JSONUIProvider>
  );
}

/** A registry entry for `genui:tree` that renders through json-render with `registry`. */
export function jsonRenderTree(registry: ComponentRegistry): GenuiRenderer<{
  root?: GenerativeUIElement;
}> {
  return function JsonRenderTreeFrame({ root }: { root?: GenerativeUIElement }) {
    return <JsonRenderTree registry={registry} {...(root !== undefined ? { root } : {})} />;
  };
}
