import type { ReactNode } from 'react';
import { XIcon } from './icons';
import { Button } from './ui/button';
import { Dialog, DialogClose, DialogDescription, DialogDrawer, DialogTitle } from './ui/dialog';

/**
 * The right-hand drawer every drill-down renders into. A drawer rather than a route because a
 * drill-down is a follow-up question about a row, not a destination: the table stays on screen and
 * behind it, so closing the drawer puts the operator back exactly where they were reading.
 *
 * Always open — the caller mounts it only when there is something to show and unmounts it to close —
 * so `onOpenChange` is only ever the primitive reporting a dismissal (Esc, an outside press, the
 * close button) back to the trail that owns the state.
 *
 * `onBack` appears only when there is somewhere to go back to (thread → run), so the two-level
 * trail is visible without the drawer having to know how deep it is.
 */
export function DetailDrawer({
  title,
  subtitle,
  onClose,
  onBack,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogDrawer aria-label={title}>
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          {onBack && (
            <Button size="xs" onClick={onBack} className="mono mt-0.5">
              ← Back
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold tracking-tight">
              {title}
            </DialogTitle>
            {subtitle !== undefined && (
              <DialogDescription className="mono mt-0.5 truncate text-[10px] text-muted-foreground">
                {subtitle}
              </DialogDescription>
            )}
          </div>
          <DialogClose
            render={
              <Button size="icon" aria-label="Close">
                <XIcon />
              </Button>
            }
          />
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </DialogDrawer>
    </Dialog>
  );
}
