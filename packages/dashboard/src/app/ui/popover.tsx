import { Popover as PopoverPrimitive } from '@base-ui-components/react/popover';
import type { ComponentProps } from 'react';
import { cn } from './cn';

/** An anchored, non-modal overlay: the day-range picker reads the numbers it is re-scoping. */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  align = 'end',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Popup> & {
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        sideOffset={sideOffset}
        className="z-50 outline-none"
      >
        <PopoverPrimitive.Popup
          className={cn(
            'origin-[var(--transform-origin)] rounded-lg border border-line bg-popover p-3 text-popover-foreground shadow-lg shadow-black/50 outline-none',
            'transition-[opacity,transform] duration-150 ease-out',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}
