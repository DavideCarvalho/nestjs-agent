import { LogoMark } from './icons';

/** What the console shows once the API answered 403: this browser may not use it. */
export function AccessDenied() {
  return (
    <div className="relative grid min-h-full place-items-center px-5 py-16">
      <div className="app-bg" />
      <div
        role="alert"
        className="relative z-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-panel px-8 py-10 text-center"
      >
        <div className="grid h-10 w-10 place-items-center rounded-lg border border-brand/40 bg-brand/10">
          <LogoMark className="h-5 w-5 text-brand" />
        </div>
        <h1 className="text-base font-semibold tracking-tight">Access denied</h1>
        <p className="text-sm text-muted-foreground">
          You are signed in, but not allowed to use this console. Ask an administrator for access.
        </p>
      </div>
    </div>
  );
}
