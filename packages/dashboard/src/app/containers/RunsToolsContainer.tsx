import { useState } from 'react';
import type { ThreadFilter, ToolCallFilter } from '../../client/agent-client';
import { RunsToolsSection } from '../RunsToolsSection';
import { useDrillDown } from '../drill-down';
import { PAGE_SIZE, pagedTable } from '../paged-table';
import { useThreadsPage, useToolCalls, useToolCallsPage } from '../use-governance';

/**
 * Runs & tools. Owns three reads and the page/filter state for two tables.
 *
 * That state living HERE rather than in `App` is a deliberate trade: leaving the section and coming
 * back clears the filters. In exchange, the eight sections nobody is looking at stop holding page
 * state for tables they are not rendering, and the state sits next to the query it keys. Filters
 * worth surviving a nav belong in the URL, like the `threadId` deep link Reliability accepts.
 */
export function RunsToolsContainer() {
  const { open } = useDrillDown();
  const toolCalls = useToolCalls();

  const [toolCallsPageNum, setToolCallsPageNum] = useState(1);
  const [toolCallsToolName, setToolCallsToolName] = useState('');
  const [toolCallsStatus, setToolCallsStatus] = useState('');
  const toolCallsFilter: ToolCallFilter = {
    ...(toolCallsToolName !== '' ? { toolName: toolCallsToolName } : {}),
    ...(toolCallsStatus !== '' ? { status: toolCallsStatus } : {}),
  };
  const toolCallsQuery = useToolCallsPage(toolCallsPageNum, PAGE_SIZE, toolCallsFilter);

  const [threadsPageNum, setThreadsPageNum] = useState(1);
  const [threadsTitle, setThreadsTitle] = useState('');
  const threadsFilter: ThreadFilter = {
    ...(threadsTitle !== '' ? { title: threadsTitle } : {}),
  };
  const threadsQuery = useThreadsPage(threadsPageNum, PAGE_SIZE, threadsFilter);

  return (
    <RunsToolsSection
      toolCalls={toolCalls.data}
      toolCallsTable={pagedTable(toolCallsQuery, toolCallsPageNum, PAGE_SIZE)}
      toolCallsFilter={toolCallsFilter}
      onToolCallsToolNameChange={(value) => {
        setToolCallsToolName(value);
        setToolCallsPageNum(1);
      }}
      onToolCallsStatusChange={(value) => {
        setToolCallsStatus(value);
        setToolCallsPageNum(1);
      }}
      onToolCallsPageChange={setToolCallsPageNum}
      threadsTable={pagedTable(threadsQuery, threadsPageNum, PAGE_SIZE)}
      threadsFilter={threadsFilter}
      onThreadsTitleChange={(value) => {
        setThreadsTitle(value);
        setThreadsPageNum(1);
      }}
      onThreadsPageChange={setThreadsPageNum}
      onOpenRun={(runId) => open({ kind: 'run', runId })}
      onOpenThread={(threadId) => open({ kind: 'thread', threadId })}
    />
  );
}
