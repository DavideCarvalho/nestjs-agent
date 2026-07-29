import { type ReactNode, useEffect, useRef } from 'react';
import { XIcon } from './icons';

/**
 * The right-hand drawer every drill-down renders into. A drawer rather than a route because a
 * drill-down is a follow-up question about a row, not a destination: the table stays on screen and
 * behind it, so closing the drawer puts the operator back exactly where they were reading.
 *
 * A native `<dialog>` opened with `showModal()`, not a styled div — that is what buys the focus
 * trap, the inert background, Esc-to-close and a real `::backdrop` without hand-rolling any of them.
 * The only thing it does not give for free is dismiss-on-backdrop-click, which is the click handler
 * below (a click whose target is the dialog itself landed outside the content box).
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
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (!element.open) element.showModal();
    // Dismiss-on-backdrop, as a real DOM listener rather than an `onClick` prop: the click is
    // pointer-only by definition (the keyboard equivalent is Esc, which the dialog handles itself),
    // and JSX would only get it past the a11y lint with a suppression that says the same thing.
    function onBackdropClick(event: MouseEvent) {
      if (event.target === element) onClose();
    }
    element.addEventListener('click', onBackdropClick);
    return () => element.removeEventListener('click', onBackdropClick);
  }, [onClose]);

  return (
    // Esc fires `cancel` then `close`; both routes end at the caller's `onClose`.
    <dialog ref={dialog} aria-label={title} className="drawer" onClose={onClose}>
      <div className="flex h-full flex-col overflow-hidden">
        <header className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="mono mt-0.5 shrink-0 rounded-md border border-[var(--line)] px-2 py-1 text-[10px] text-[var(--muted)] transition-colors hover:text-[var(--text)]"
            >
              ← Back
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold tracking-tight">{title}</h2>
            {subtitle !== undefined && (
              <p className="mono mt-0.5 truncate text-[10px] text-[var(--muted)]">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md border border-[var(--line)] p-1.5 text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          >
            <XIcon />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </dialog>
  );
}
