import { useConsoleTenancy } from './use-governance';

/**
 * The Organization the console is scoped to, with the agent's tenancy on: its path (clinic › unit),
 * labelled by the app's `tenancy.label`. Nothing with tenancy off.
 */
export function OrganizationChip() {
  const { data } = useConsoleTenancy();
  if (data === undefined || !data.enabled) return null;
  const text =
    data.scope === 'all'
      ? 'All organizations'
      : data.scope === 'tenantless'
        ? 'No organization'
        : data.chain.map((level) => level.label).join(' › ');
  const title =
    data.scope === 'tenant'
      ? data.chain.map((level) => `${level.kind} ${level.id}`).join(' › ')
      : undefined;
  return (
    <span
      className="flex h-[26px] max-w-[22rem] min-w-0 items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2.5 text-[11px]"
      title={title}
      data-testid="organization-chip"
    >
      <span className="hidden text-faint sm:inline">Organization</span>
      <span className="truncate font-medium text-fg-2">{text}</span>
    </span>
  );
}
