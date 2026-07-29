import { Tabs as TabsPrimitive } from '@base-ui-components/react/tabs';
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
      className={cn('inline-flex items-center gap-1 rounded-md', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        'rounded-md border border-transparent px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
        // `data-active`, not `data-selected`: Base UI's Tab exposes the active tab as
        // `data-active` (`data-selected` belongs to Select's items). The wrong one compiles
        // fine and silently never matches.
        'data-[active]:border-brand data-[active]:bg-brand/10 data-[active]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export const TabsContent = TabsPrimitive.Panel;
