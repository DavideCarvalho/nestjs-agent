import { useQueryStates } from 'nuqs';
import type { ThreadFilter, ToolCallFilter } from '../../client/agent-client';
import { RunsToolsSection } from '../RunsToolsSection';
import { useDrillDown } from '../drill-down';
import { PAGE_SIZE, pagedTable } from '../paged-table';
import { pageParam, textParam } from '../url-state';
import { useThreadsPage, useToolCalls, useToolCallsPage } from '../use-governance';

/**
 * Both tables' view state in the URL: `#/runs?tool=search&toolStatus=error&toolPage=2` and
 * `threadTitle` / `threadPage` (not `thread`: that param opens a thread's drawer).
 */
const RUNS_TOOLS_VIEW = {
  tool: textParam,
  toolStatus: textParam,
  toolPage: pageParam,
  threadTitle: textParam,
  threadPage: pageParam,
};

/** Typing rewrites the current history entry, even though resetting the page alone would push. */
const TYPING = { history: 'replace' } as const;

/**
 * Runs & tools. Owns three reads and the page/filter state for two tables.
 *
 * That state lives in the hash's query, so a filtered table is a link and survives a reload;
 * leaving the section still starts the next visit fresh. Typing a filter rewrites the current
 * history entry and goes back to page 1; paging adds an entry.
 */
export function RunsToolsContainer() {
  const { open } = useDrillDown();
  const toolCalls = useToolCalls();

  const [view, setView] = useQueryStates(RUNS_TOOLS_VIEW);
  const {
    tool: toolCallsToolName,
    toolStatus: toolCallsStatus,
    toolPage: toolCallsPageNum,
    threadTitle: threadsTitle,
    threadPage: threadsPageNum,
  } = view;
  const toolCallsFilter: ToolCallFilter = {
    ...(toolCallsToolName !== '' ? { toolName: toolCallsToolName } : {}),
    ...(toolCallsStatus !== '' ? { status: toolCallsStatus } : {}),
  };
  const toolCallsQuery = useToolCallsPage(toolCallsPageNum, PAGE_SIZE, toolCallsFilter);

  const threadsFilter: ThreadFilter = {
    ...(threadsTitle !== '' ? { title: threadsTitle } : {}),
  };
  const threadsQuery = useThreadsPage(threadsPageNum, PAGE_SIZE, threadsFilter);

  return (
    <RunsToolsSection
      toolCalls={toolCalls.data}
      toolCallsTable={pagedTable(toolCallsQuery, toolCallsPageNum, PAGE_SIZE)}
      toolCallsFilter={toolCallsFilter}
      onToolCallsToolNameChange={(value) => void setView({ tool: value, toolPage: null }, TYPING)}
      onToolCallsStatusChange={(value) =>
        void setView({ toolStatus: value, toolPage: null }, TYPING)
      }
      onToolCallsPageChange={(next) => void setView({ toolPage: next })}
      threadsTable={pagedTable(threadsQuery, threadsPageNum, PAGE_SIZE)}
      threadsFilter={threadsFilter}
      onThreadsTitleChange={(value) =>
        void setView({ threadTitle: value, threadPage: null }, TYPING)
      }
      onThreadsPageChange={(next) => void setView({ threadPage: next })}
      onOpenRun={(runId) => open({ kind: 'run', runId })}
      onOpenThread={(threadId) => open({ kind: 'thread', threadId })}
    />
  );
}
