---
'@dudousxd/nestjs-agent-dashboard': minor
---

**`dashboardAuth.unauthenticatedPage` — hosts can now render the console's unauthenticated page themselves.**

Under Mode A, a browser reaching the console without a session is redirected to
`<basePath>/auth/session-required`, which served a fixed, library-rendered card: *"Open this console
from your application."* Deliberately generic, because the library cannot know who hosts it — it
can't name the host's launcher, link to it, or look like the rest of the host's product.

The new `unauthenticatedPage` hook hands the whole response to the host:

```ts
dashboardAuth: {
  secret: process.env.AGENT_DASHBOARD_SECRET,
  session: (request) => resolveAdmin(request),
  unauthenticatedPage: ({ request, response, basePath }) => {
    (response as Response).status(401).render('console-locked', { returnTo: basePath });
  },
}
```

It receives the platform-native request/response (Express, Fastify — same `unknown` typing as
`session`, for the same reason) plus `basePath`, and owns the response: it must write AND end it. It
changes what `<basePath>/auth/session-required` *contains*, not the flow that reaches it, so the
existing redirect behaviour is untouched.

Fail-closed by construction: the hook only ever runs on a request that has ALREADY been denied, so
it cannot grant access — an accompanying test asserts the API stays `401` and a page navigation is
still bounced even when the hook answers `200`. A hook that throws, or that returns without writing,
logs one warning and falls back to the built-in page rather than hanging the request or turning a
denial into a `500`. It is also not a mode: `unauthenticatedPage` alone still fails boot on the
existing "at least one of `session` or `login`" check. Under Mode B the route continues to `404` —
configuring a page hook does not conjure it into being.

Not a replacement for Mode B's built-in login form. A host that wants its own *login* UI combines
Mode A with this hook and posts to `<basePath>/auth/session` from its own page; that mint endpoint
is the supported primitive for it.

Fully backward compatible — omit the option and the built-in page is unchanged.
