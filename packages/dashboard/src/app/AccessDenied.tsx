import { LogoMark } from './icons';

/** What the console shows once the API answered 403: this browser may not use it. */
export function AccessDenied() {
  return (
    <div className="relative grid min-h-svh place-items-center px-5 py-16">
      <div className="aviary-glow" aria-hidden />
      <div
        role="alert"
        className="aviary-surface aviary-rise relative z-10 flex max-w-md flex-col items-center gap-3 rounded-lg border border-border px-8 py-10 text-center"
      >
        <div className="grid size-10 place-items-center rounded-md border border-brand-border bg-brand-soft text-brand">
          <LogoMark className="size-5" />
        </div>
        <h1 className="text-base font-bold tracking-[0.01em] text-fg">Access denied</h1>
        <p className="text-sm text-dim">
          You are signed in, but not allowed to use this console. Ask an administrator for access.
        </p>
      </div>
    </div>
  );
}
