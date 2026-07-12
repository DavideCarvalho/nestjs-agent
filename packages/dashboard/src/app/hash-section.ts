/**
 * Hash-route model for the console's section nav — deep-linkable tabs (`/ai-gateway#/reliability`
 * etc.), same convention as the durable console. Deliberately tiny: no router dependency, just a
 * `SectionKey` ↔ `location.hash` mapping the SPA reads on load and on `hashchange`.
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

function isSectionKey(value: string): value is SectionKey {
  return SECTION_KEYS.some((key) => key === value);
}

/**
 * The active `SectionKey` for a `location.hash` value (e.g. `#/reliability`). An empty hash or one
 * that doesn't name a known section falls back to {@link DEFAULT_SECTION}.
 */
export function sectionFromHash(hash: string): SectionKey {
  const slug = hash.replace(/^#\/?/, '');
  return isSectionKey(slug) ? slug : DEFAULT_SECTION;
}

/** The `href` a nav anchor uses for `section` — `#/<key>`. */
export function hashForSection(section: SectionKey): string {
  return `#/${section}`;
}
