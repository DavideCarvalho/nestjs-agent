import { QueryOrder, type QueryOrderMap } from '@mikro-orm/core';
import type { AgentMessage } from './entities/agent-message.entity';

/**
 * A thread's messages in the order they were appended: by `seq`, which append assigns. A row from
 * before `seq` existed has none and sorts FIRST — every such row is older than every numbered one —
 * among its own kind by `created_at`, then `id`, as it always did. `nulls first` is spelled out
 * because the default differs: Postgres sorts nulls last, MySQL and SQLite first.
 */
export const MESSAGE_ORDER: QueryOrderMap<AgentMessage>[] = [
  { seq: QueryOrder.ASC_NULLS_FIRST },
  { createdAt: QueryOrder.ASC },
  { id: QueryOrder.ASC },
];

/** {@link MESSAGE_ORDER} reversed — newest first, for a window read and the last-message preview. */
export const MESSAGE_ORDER_NEWEST_FIRST: QueryOrderMap<AgentMessage>[] = [
  { seq: QueryOrder.DESC_NULLS_LAST },
  { createdAt: QueryOrder.DESC },
  { id: QueryOrder.DESC },
];
