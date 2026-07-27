// packages/dashboard/src/server/auth/login-page.ts

/** Escape untrusted text placed into the HTML body/attributes below. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LoginPageOptions {
  /** Where the login form POSTs (`<basePath>/auth/login`). */
  actionUrl: string;
  /** Carried through as a hidden field so a successful login returns to where the visit started. */
  returnTo: string;
  /** Render the generic "invalid credentials" banner. */
  error?: boolean;
}

/**
 * Shared HTML shell for the `dashboardAuth` server-rendered pages (the Mode B login form below and
 * `renderSessionRequiredPage`'s Mode A instruction page) — same dark zinc card, mono type, emerald
 * accent, so every auth-adjacent page in this console reads as one product. `content` is placed
 * inside the `.card` div verbatim — always caller-controlled static/escaped markup, never raw user
 * input, so this sidesteps HTML-escaping entirely.
 */
function pageShell(content: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #09090b;
    color: #e4e4e7;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 16px;
  }
  .card {
    width: 100%;
    max-width: 384px;
    border: 1px solid #27272a;
    background: #18181b;
    border-radius: 8px;
    padding: 32px;
    box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5);
  }
  .brand {
    margin: 0 0 24px;
    text-align: center;
    font-size: 18px;
    font-weight: 600;
    color: #34d399;
  }
  h1 {
    margin: 0 0 12px;
    font-size: 16px;
    font-weight: 600;
    color: #f4f4f5;
  }
  p { margin: 0 0 16px; color: #a1a1aa; }
  form { display: flex; flex-direction: column; gap: 16px; }
  label { display: flex; flex-direction: column; gap: 6px; }
  .field-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #71717a;
  }
  input {
    border-radius: 4px;
    border: 1px solid #3f3f46;
    background: #09090b;
    color: #f4f4f5;
    padding: 8px 12px;
    font: inherit;
    outline: none;
  }
  input:focus { border-color: rgb(52 211 153 / 0.6); }
  .error { margin: 0; font-size: 12px; color: #fb7185; }
  button {
    margin-top: 8px;
    border-radius: 4px;
    border: 1px solid rgb(52 211 153 / 0.4);
    background: rgb(52 211 153 / 0.1);
    color: #6ee7b7;
    padding: 8px 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
  }
  button:hover { background: rgb(52 211 153 / 0.2); }
</style>
</head>
<body>
  <div class="card">
    ${content}
  </div>
</body>
</html>`;
}

/**
 * A dependency-free, server-rendered login page — no build step, no client JS framework. The
 * visual language (dark zinc card, mono type, emerald accent) mirrors
 * `@dudousxd/nestjs-telescope`'s built-in `AuthScreen` so the two consoles feel like one family.
 */
export function renderLoginPage(options: LoginPageOptions): string {
  const action = escapeHtml(options.actionUrl);
  const returnTo = escapeHtml(options.returnTo);
  const errorBanner =
    options.error === true ? '<p role="alert" class="error">Invalid username or password.</p>' : '';
  return pageShell(
    `<p class="brand">AI Gateway</p>
    <form method="post" action="${action}">
      <input type="hidden" name="returnTo" value="${returnTo}" />
      <label>
        <span class="field-label">Username</span>
        <input type="text" name="username" autocomplete="username" autofocus />
      </label>
      <label>
        <span class="field-label">Password</span>
        <input type="password" name="password" autocomplete="current-password" />
      </label>
      ${errorBanner}
      <button type="submit">Sign in</button>
    </form>`,
    'Sign in — AI Gateway',
  );
}

/**
 * Mode-A-only landing (`GET <basePath>/auth/login` 404s under Mode A — see
 * `AgentDashboardAuthController.loginPage`): what `DashboardAuthPageGuard` bounces an
 * unauthenticated page navigation to instead, since there is no login form to redirect to — the
 * host mints the session itself, typically from its own console launcher. Static and
 * parameter-free: nothing on this page varies per request, so there's no `basePath` (or anything
 * else) to interpolate — no `<script>`/inline handler either, so the page stays inert under a host
 * CSP that omits `'unsafe-inline'` from `script-src`.
 */
export function renderSessionRequiredPage(): string {
  return pageShell(
    `<p class="brand">AI Gateway</p>
    <h1>Open this console from your application</h1>
    <p>Your session is minted by the host app. Use its console launcher to sign in, then reload.</p>`,
    'Sign in — AI Gateway',
  );
}
