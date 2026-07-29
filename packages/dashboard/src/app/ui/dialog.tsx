import { Dialog as DialogPrimitive } from '@base-ui-components/react/dialog';
import type { ComponentProps } from 'react';
import { cn } from './cn';

/**
 * Base UI Dialog. Modal by default, which is what buys the focus trap, the scroll lock, the inert
 * background, Esc-to-close and dismiss-on-outside-press — the same guarantees the console used to
 * get from `<dialog>` + `showModal()`, now from the same primitive layer as everything else.
 *
 * A portalled div is NOT in the browser's top layer, and that is the point rather than a shortcoming:
 * a `showModal()` dialog outranks every `z-index` there is, so anything that must paint OVER a modal
 * — a toast fired while the drawer is open — is silently invisible. Ordinary stacking keeps working.
 * Backdrop and popup sit at `z-50`, above the console's own `z-10` content plane, and deliberately
 * below whatever a future toast layer claims.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

/**
 * A full-height panel pinned to the right edge, with its own portal and backdrop.
 *
 * Portal and backdrop are folded in rather than left to the caller because Base UI throws — at
 * click time, not at build time — if a `Dialog.Popup` is mounted outside a `Dialog.Portal`. Owning
 * both here makes that impossible to get wrong from a call site.
 *
 * A drawer rather than a centred box because a drill-down is a follow-up question about a row, not a
 * destination: the table stays on screen behind it, so closing puts the operator back exactly where
 * they were reading.
 */
export function DialogDrawer({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Popup>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className={cn(
          'fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] transition-opacity duration-200',
          'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
        )}
      />
      <DialogPrimitive.Popup
        className={cn(
          // `bg-panel-2`: AVIARY-UI.md calls --panel-2 the modal/dialog surface, so the drawer reads
          // as lifted off the page rather than as a second page pinned to the right edge.
          'fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-[720px] flex-col overflow-hidden border-l border-line bg-panel-2 text-foreground outline-none',
          'transition-transform duration-200 ease-out',
          'data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full',
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}
