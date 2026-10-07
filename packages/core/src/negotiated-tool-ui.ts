import { snapshotActionProposal } from './action-proposal-transitions.js';
import { prepareUiEmission } from './genui/capabilities.js';
import type { Catalog } from './genui/catalog.js';
import type { ToolDescribeScope } from './spi/tool.js';
import type { AgentStreamEvent } from './stream-events.js';
import { type UiCollector, createUiCollector } from './tool-ui.js';
export type ResolveToolUiCatalog = (scope: ToolDescribeScope) => Catalog | Promise<Catalog>;
export interface NegotiatedUiCollector extends UiCollector {
  text(): string;
}
export function createNegotiatedUiCollector(
  toolCallId: string,
  scope: ToolDescribeScope,
  resolveCatalog?: ResolveToolUiCatalog,
  write?: (event: AgentStreamEvent) => void | Promise<void>,
): NegotiatedUiCollector {
  const collector = createUiCollector(toolCallId, write);
  const texts = new Map<string, string>();
  let next = 0;
  return {
    components: collector.components,
    text: () => [...texts.values()].join('\n'),
    restart: () => {
      next = 0;
      texts.clear();
      collector.restart();
    },
    emit: async (component, props, options = {}) => {
      if (!resolveCatalog) {
        // No server catalog to negotiate against: the client's declaration can only narrow what is
        // drawn. A component it does not declare (at this version) degrades to its fallback text,
        // else is left out — never a throw, which would fail the tool body itself.
        const declared =
          scope.uiCapabilities === undefined ||
          scope.uiCapabilities.components.some(
            (entry) => entry.name === component && entry.version === (options.version ?? 1),
          );
        if (declared) return collector.emit(component, props, options);
        const id = options.id ?? `${toolCallId}:ui:${next++}`;
        if (options.fallbackText !== undefined && options.fallbackText.length > 0) {
          texts.set(id, options.fallbackText);
          await write?.({ kind: 'text', text: options.fallbackText });
        }
        return { id };
      }
      const capturedProps = snapshotActionProposal(props);
      const capturedOptions = { ...options };
      const catalog = await resolveCatalog(scope);
      const prepared = await prepareUiEmission(
        catalog,
        scope.uiCapabilities,
        component,
        capturedProps,
        capturedOptions.version,
      );
      const id = capturedOptions.id ?? `${toolCallId}:ui:${next++}`;
      if (prepared.kind === 'text') {
        texts.set(id, prepared.text);
        await write?.({ kind: 'text', text: prepared.text });
        return { id };
      }
      return collector.emit(prepared.component, prepared.props, {
        id,
        version: prepared.version,
        fallbackText: prepared.fallbackText,
        ...(prepared.componentVersions !== undefined
          ? { componentVersions: prepared.componentVersions }
          : {}),
      });
    },
  };
}
