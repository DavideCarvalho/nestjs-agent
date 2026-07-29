/**
 * Hash-route model for the console's section nav — deep-linkable tabs (`/ai-gateway#/reliability`
 * etc.), same convention as the durable console. Deliberately tiny: no router dependency, just a
 * `SectionKey` ↔ `location.hash` mapping the SPA reads on load and on `hashchange`.
 *
 * A route may carry a query tail (`#/reliability?threadId=th2`). That is how one section links INTO
 * another with a filter already applied — a thread drill-down's "show all runs on this thread" is a
 * link, not cross-section state, so it survives a reload and can be pasted into a ticket.
 */

export const SECTION_KEYS = [
  'spend',
  'models',
  'actors',
  'runs',
  'reliability',
  'approvals',
  'tools',
  'pricing',
  'live',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** The section the console opens on for an empty/unknown hash. */
export const DEFAULT_SECTION: SectionKey = 'spend';

/** A parsed hash route: the active section plus whatever its query tail carried. */
export interface HashRoute {
  section: SectionKey;
  params: URLSearchParams;
}

function isSectionKey(value: string): value is SectionKey {
  return SECTION_KEYS.some((key) => key === value);
}

/**
 * The active `SectionKey` for a `location.hash` value (e.g. `#/reliability`). An empty hash or one
 * that doesn't name a known section falls back to {@link DEFAULT_SECTION}. A query tail is ignored.
 */
export function sectionFromHash(hash: string): SectionKey {
  return routeFromHash(hash).section;
}

/**
 * Parse a full `location.hash` into its section and query tail. An unknown section falls back to
 * {@link DEFAULT_SECTION} and its params are DROPPED — params only mean something to the section
 * that declared them, so carrying them onto the fallback would apply a filter nobody asked for.
 */
export function routeFromHash(hash: string): HashRoute {
  const raw = hash.replace(/^#\/?/, '');
  const separator = raw.indexOf('?');
  const slug = separator === -1 ? raw : raw.slice(0, separator);
  if (!isSectionKey(slug)) {
    return { section: DEFAULT_SECTION, params: new URLSearchParams() };
  }
  return {
    section: slug,
    params: new URLSearchParams(separator === -1 ? '' : raw.slice(separator + 1)),
  };
}

/** The `href` a nav anchor uses for `section` — `#/<key>`, with a `?a=b` tail when `params` is given. */
export function hashForSection(section: SectionKey, params?: Record<string, string>): string {
  const query = params === undefined ? '' : new URLSearchParams(params).toString();
  return query === '' ? `#/${section}` : `#/${section}?${query}`;
}
