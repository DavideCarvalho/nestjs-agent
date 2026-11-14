import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import type { ComponentProps } from 'react';
import { cn } from './cn';

/**
 * A segmented control for switching what a panel is SHOWING (cost vs tokens), not for navigating.
 *
 * A primitive rather than two buttons and a `useState` because the roving tabindex, the arrow-key
 * traversal and the `role="tab"`/`aria-selected` wiring are the whole difference between a segmented
 * control and two buttons that happen to look like one — and none of it shows up in a screenshot.
 */
export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-border bg-panel-2 p-0.5',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        'rounded-[5px] border border-transparent px-2 py-0.5 text-[11px] text-dim outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50',
        // `data-active`, not `data-selected`: Base UI's Tab exposes the active tab as
        // `data-active` (`data-selected` belongs to Select's items). The wrong one compiles
        // fine and silently never matches.
        'data-[active]:border-brand-border data-[active]:bg-brand-soft data-[active]:text-fg',
        className,
      )}
      {...props}
    />
  );
}

export const TabsContent = TabsPrimitive.Panel;
