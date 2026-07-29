import { Select as SelectPrimitive } from '@base-ui-components/react/select';
import type { ComponentProps } from 'react';
import { CheckIcon, ChevronDownIcon } from '../icons';
import { cn } from './cn';

/**
 * Base UI Select, not `<select>`.
 *
 * A native `<select>` renders its list in a UA popup no stylesheet reaches, so a dark console gets a
 * light system list in the platform's own type. That is the test: reach for the primitive layer when
 * the platform element cannot be made to look or behave like the rest of the console.
 *
 * Enter/exit is `data-starting-style` / `data-ending-style` on a plain transition — Base UI's model,
 * and the reason this console needs no animation plugin.
 */
export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'mono flex items-center justify-between gap-1.5 rounded-md border border-input bg-panel px-2 py-1 text-[11px] text-foreground outline-none transition-colors focus-visible:border-brand/50 data-[popup-open]:border-brand/50',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDownIcon width={12} height={12} className="text-muted-foreground" />}
      />
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof SelectPrimitive.Popup> & { sideOffset?: number }) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        sideOffset={sideOffset}
        alignItemWithTrigger={false}
        className="z-50 outline-none"
      >
        <SelectPrimitive.Popup
          className={cn(
            'min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-hidden rounded-md border border-line bg-popover p-1 text-popover-foreground shadow-lg shadow-black/50',
            'transition-[opacity,transform] duration-150 ease-out',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'mono relative flex cursor-pointer select-none items-center gap-2 rounded-sm py-1 pl-6 pr-2 text-[11px] text-muted-foreground outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[selected]:text-foreground',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="absolute left-1 flex items-center text-brand">
        <CheckIcon width={11} height={11} />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
