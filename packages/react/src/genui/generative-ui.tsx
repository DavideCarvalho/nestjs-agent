import {
  Component,
  type ErrorInfo,
  type ReactNode,
  createContext,
  useContext,
  useMemo,
} from 'react';
import type { TranscriptUiBlock } from '../transcript/model.js';
import type {
  GenerativeUIElement,
  GenerativeUIItem,
  GenerativeUIOptions,
  GenerativeUIProblem,
  GenerativeUIState,
  GenuiRenderer,
} from './types.js';
import {
  useGenerativeUIState,
  useResolvedComponent,
  useValidatedProps,
} from './use-generative-ui.js';

/** What to draw instead of a component that did not render. Default: nothing. */
export type GenerativeUIFallback = ReactNode | ((problem: GenerativeUIProblem) => ReactNode);

interface TreeScope {
  options: GenerativeUIOptions;
  fallback: GenerativeUIFallback | undefined;
  loading: ReactNode;
  onError: ((error: unknown, item: GenerativeUIItem) => void) | undefined;
}

const TreeScopeContext = createContext<TreeScope | null>(null);

function renderFallback(fallback: GenerativeUIFallback | undefined, problem: GenerativeUIProblem) {
  if (typeof fallback === 'function') return fallback(problem);
  return fallback ?? null;
}

interface BoundaryProps {
  item: GenerativeUIItem;
  fallback: GenerativeUIFallback | undefined;
  onError: ((error: unknown, item: GenerativeUIItem) => void) | undefined;
  children: ReactNode;
}

/** One failing renderer takes down its own item, never the message around it. */
class ItemBoundary extends Component<BoundaryProps, { error: unknown; failed: boolean }> {
  override state = { error: undefined as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo) {
    this.props.onError?.(error, this.props.item);
  }

  override componentDidUpdate(previous: BoundaryProps) {
    // New props for the same item (a streamed update) get a fresh chance to render.
    if (this.state.failed && previous.item !== this.props.item) {
      this.setState({ error: undefined, failed: false });
    }
  }

  override render() {
    if (this.state.failed) {
      return renderFallback(this.props.fallback, {
        reason: 'error',
        item: this.props.item,
        error: this.state.error,
      });
    }
    return this.props.children;
  }
}

function nodeItem(node: GenerativeUIElement, id: string): GenerativeUIItem {
  return { id, component: node.type, props: node.props ?? {}, version: null, toolCallId: null };
}

/** One tree node: resolved and validated like a top-level item, children rendered as its `children`. */
function TreeNode({ node, id }: { node: GenerativeUIElement; id: string }) {
  const scope = useContext(TreeScopeContext);
  const item = useMemo(() => nodeItem(node, id), [node, id]);
  const resolution = useResolvedComponent(
    node.type,
    null,
    scope?.options.registry ?? {},
    scope?.options.resolveComponent,
  );
  const validation = useValidatedProps(scope?.options.catalog, node.type, item.props);
  if (scope === null) return null;
  if (resolution.status === 'loading' || validation.status === 'pending') return scope.loading;
  if (resolution.status === 'unknown') {
    return renderFallback(scope.fallback, { reason: 'unknown', item });
  }
  if (resolution.status === 'error') {
    return renderFallback(scope.fallback, { reason: 'error', item, error: resolution.error });
  }
  if (validation.status === 'invalid') {
    return renderFallback(scope.fallback, { reason: 'invalid', item, issues: validation.issues });
  }
  const Renderer = resolution.Component;
  const children = Array.isArray(node.children) ? node.children : [];
  return (
    <Renderer {...validation.props}>
      {children.length > 0
        ? children.map((child, index) => {
            const childId = `${id}.${index}`;
            return (
              <ItemBoundary
                key={childId}
                item={nodeItem(child, childId)}
                fallback={scope.fallback}
                onError={scope.onError}
              >
                <TreeNode node={child} id={childId} />
              </ItemBoundary>
            );
          })
        : undefined}
    </Renderer>
  );
}

/**
 * Renders a `genui:tree` frame's `{ root }` node by node through the same registry, catalog and
 * resolver as top-level components. Used automatically for tree frames unless the registry
 * overrides `genui:tree` (e.g. with the json-render adapter).
 */
export function GenuiTree({ root }: { root?: GenerativeUIElement }) {
  if (root === undefined || root === null || typeof root.type !== 'string') return null;
  return <TreeNode node={root} id="root" />;
}

export interface GenerativeUIScopeProps extends GenerativeUIOptions {
  fallback?: GenerativeUIFallback;
  loading?: ReactNode;
  onError?: (error: unknown, item: GenerativeUIItem) => void;
  children?: ReactNode;
}

/**
 * The registry, catalog and fallbacks tree nodes render with. `<GenerativeUI>` provides it; wrap
 * your own chrome in it when you draw `useGenerativeUI`'s `Component` yourself and it may be a tree.
 */
export function GenerativeUIScope({
  registry,
  catalog,
  resolveComponent,
  fallback,
  loading = null,
  onError,
  children,
}: GenerativeUIScopeProps) {
  const scope = useMemo<TreeScope>(
    () => ({
      options: {
        registry,
        ...(catalog !== undefined ? { catalog } : {}),
        ...(resolveComponent !== undefined ? { resolveComponent } : {}),
      },
      fallback,
      loading,
      onError,
    }),
    [registry, catalog, resolveComponent, fallback, loading, onError],
  );
  return <TreeScopeContext.Provider value={scope}>{children}</TreeScopeContext.Provider>;
}

/** The headless half of {@link GenerativeUI}: what to draw for one pushed component, or `null` when `part` is not one. */
export function useGenerativeUI(
  part: unknown,
  options: GenerativeUIOptions,
): GenerativeUIState | null {
  return useGenerativeUIState(part, options, GenuiTree as GenuiRenderer);
}

export interface GenerativeUIProps extends GenerativeUIOptions {
  /** A transcript `ui` block, a `data-ui` message part, or a stored `{ id, component, props, version? }`. */
  part: TranscriptUiBlock | GenerativeUIItem | unknown;
  /** Drawn for an unknown component, invalid props, or a renderer that threw. Default: nothing. */
  fallback?: GenerativeUIFallback;
  /** Drawn while a resolver or an async validation is pending. Default: nothing. */
  loading?: ReactNode;
  /** A renderer threw (the item shows `fallback`). */
  onError?: (error: unknown, item: GenerativeUIItem) => void;
}

/**
 * Draws one server-pushed component with the app's own renderer. Headless: it adds no element and
 * no style of its own — only what the registry's component renders (and whatever `fallback` /
 * `loading` you pass).
 *
 * ```tsx
 * <MessageItem message={m} renderUi={(block) => (
 *   <GenerativeUI part={block} registry={registry} catalog={catalog} fallback={({ item }) => <Unknown name={item.component} />} />
 * )} />
 * ```
 */
export function GenerativeUI({
  part,
  registry,
  catalog,
  resolveComponent,
  fallback,
  loading = null,
  onError,
}: GenerativeUIProps) {
  const options = useMemo<GenerativeUIOptions>(
    () => ({
      registry,
      ...(catalog !== undefined ? { catalog } : {}),
      ...(resolveComponent !== undefined ? { resolveComponent } : {}),
    }),
    [registry, catalog, resolveComponent],
  );
  const state = useGenerativeUI(part, options);
  if (state === null) return null;
  if (state.status === 'loading') return loading;
  if (state.status === 'problem') {
    const { status: _status, ...problem } = state;
    return renderFallback(fallback, problem);
  }
  const Renderer = state.Component;
  return (
    <GenerativeUIScope
      {...options}
      fallback={fallback}
      loading={loading}
      {...(onError !== undefined ? { onError } : {})}
    >
      <ItemBoundary item={state.item} fallback={fallback} onError={onError}>
        <Renderer {...state.props} />
      </ItemBoundary>
    </GenerativeUIScope>
  );
}
