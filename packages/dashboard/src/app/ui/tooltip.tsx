import { Tooltip as TooltipPrimitive } from '@base-ui-components/react/tooltip';
import type { ComponentProps, ReactElement } from 'react';
import { cn } from './cn';

/**
 * A tooltip for the identifiers this console has to truncate.
 *
 * The native `title` attribute technically works and was what the tables used. It is also invisible
 * to a keyboard user, takes about a second to appear, and renders in the OS's own light chrome — so
 * the full model id or run id an operator needs was in the DOM and effectively unreachable.
 */
export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  label,
  children,
  side = 'top',
  className,
  ...props
}: Omit<ComponentProps<typeof TooltipPrimitive.Root>, 'children'> & {
  /** The full text the trigger had to shorten. Nothing extra renders when it is empty. */
  label: string;
  /**
   * The truncated element itself. It BECOMES the trigger (Base UI's `render`) rather than being
   * wrapped in one — a wrapper element around a `truncate` cell is how a table row starts overflowing
   * its column.
   */
  children: ReactElement<Record<string, unknown>>;
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  if (label === '') return children;
  return (
    <TooltipPrimitive.Root {...props}>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup
            className={cn(
              'mono max-w-[min(28rem,90vw)] origin-[var(--transform-origin)] break-words rounded-md border border-line bg-popover px-2 py-1 text-[10px] text-popover-foreground shadow-lg shadow-black/50',
              'transition-[opacity,transform] duration-150 ease-out',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              className,
            )}
          >
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
