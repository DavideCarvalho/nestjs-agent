import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { isSafeHref } from './ConsoleSwitcher';
import { ConsoleIcon, type ConsoleIconKey, iconKey } from './console-switcher-icons';

/** One hit of `GET <api>/consoles/search`. */
export interface ConsoleSearchHit {
  title: string;
  subtitle?: string;
  href: string;
}

/** One console's hits. */
export interface ConsoleSearchGroup {
  id: string;
  title: string;
  icon: ConsoleIconKey;
  hits: ConsoleSearchHit[];
}

/** What the palette shows for a query. */
export interface ConsoleSearchAnswer {
  results: ConsoleSearchGroup[];
  partial: boolean;
}

/** The usable part of a search answer: unsafe `href`s and malformed entries dropped. */
export function sanitizeSearchAnswer(value: unknown): ConsoleSearchAnswer {
  const body = (typeof value === 'object' && value !== null ? value : {}) as {
    results?: unknown;
    partial?: unknown;
  };
  const groups = Array.isArray(body.results) ? body.results : [];
  const results = groups.flatMap((group: unknown): ConsoleSearchGroup[] => {
    if (typeof group !== 'object' || group === null) return [];
    const g = group as Record<string, unknown>;
    if (typeof g.id !== 'string' || typeof g.title !== 'string' || !Array.isArray(g.hits))
      return [];
    const hits = g.hits.flatMap((hit: unknown): ConsoleSearchHit[] => {
      if (typeof hit !== 'object' || hit === null) return [];
      const h = hit as Record<string, unknown>;
      if (typeof h.title !== 'string' || h.title === '' || !isSafeHref(h.href)) return [];
      return [
        {
          title: h.title,
          ...(typeof h.subtitle === 'string' ? { subtitle: h.subtitle } : {}),
          href: h.href,
        },
      ];
    });
    return hits.length > 0 ? [{ id: g.id, title: g.title, icon: iconKey(g.icon), hits }] : [];
  });
  return { results, partial: body.partial === true };
}

/** Ask the search endpoint. Any failure reads as no hits. */
export async function fetchConsoleSearch(
  endpoint: string,
  q: string,
  signal?: AbortSignal,
): Promise<ConsoleSearchAnswer> {
  try {
    const res = await fetch(`${endpoint}?q=${encodeURIComponent(q)}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      ...(signal !== undefined ? { signal } : {}),
    });
    // A failed search is partial, never "no results": nothing was searched.
    return res.ok ? sanitizeSearchAnswer(await res.json()) : { results: [], partial: true };
  } catch {
    return { results: [], partial: true };
  }
}

/** Navigate to a hit (a same-origin path). Overridable in tests. */
function go(href: string): void {
  window.location.assign(href);
}

/**
 * Global search across the Aviary consoles: a palette opened with Ctrl/Cmd-K, from its header button,
 * or from the console switcher's menu (`open` / `onOpenChange`). Hits are grouped per console.
 */
export function ConsoleSearch({
  endpoint,
  open,
  onOpenChange,
  navigate = go,
}: {
  endpoint: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate?: (href: string) => void;
}) {
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<ConsoleSearchAnswer>({ results: [], partial: false });
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) input.current?.focus();
    else setQ('');
  }, [open]);

  useEffect(() => {
    const query = q.trim();
    if (!open || query === '') {
      setAnswer({ results: [], partial: false });
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void fetchConsoleSearch(endpoint, query, abort.signal).then((next) => {
        if (abort.signal.aborted) return;
        setAnswer(next);
        setLoading(false);
      });
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [q, open, endpoint]);

  if (!open) return null;

  const options = () => Array.from(list.current?.querySelectorAll<HTMLElement>('a[href]') ?? []);
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onOpenChange(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const all = options();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? at + 1 : at <= 0 ? -1 : at - 1;
    if (next < 0) input.current?.focus();
    else all[Math.min(next, all.length - 1)]?.focus();
  };
  const first = answer.results[0]?.hits[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
      data-aviary-search=""
    >
      <dialog
        open
        aria-modal="true"
        aria-label="Search all consoles"
        onKeyDown={onKey}
        className="static m-0 w-full max-w-lg overflow-hidden rounded-lg border border-line bg-popover p-0 text-foreground shadow-lg shadow-black/50"
      >
        <input
          ref={input}
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && first !== undefined) {
              event.preventDefault();
              onOpenChange(false);
              navigate(first.href);
            }
          }}
          placeholder="Search runs, threads and the other consoles…"
          aria-label="Search all consoles"
          className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div ref={list} className="max-h-[60vh] overflow-y-auto p-1">
          {answer.results.map((group) => (
            <section key={group.id} aria-label={group.title} className="py-1">
              <div className="flex items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                <ConsoleIcon icon={group.icon} />
                {group.title}
              </div>
              {group.hits.map((hit) => (
                <a
                  key={hit.href}
                  href={hit.href}
                  // A hit in this console is only a hash change: close the palette over it.
                  onClick={() => onOpenChange(false)}
                  className="block rounded-md px-2 py-1.5 text-sm text-foreground outline-none hover:bg-panel focus:bg-panel"
                >
                  <span className="block truncate">{hit.title}</span>
                  {hit.subtitle !== undefined && (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {hit.subtitle}
                    </span>
                  )}
                </a>
              ))}
            </section>
          ))}
          {q.trim() !== '' && !loading && answer.results.length === 0 && !answer.partial && (
            <p className="px-2 py-3 text-sm text-muted-foreground">No results.</p>
          )}
          {answer.partial && (
            <output className="block px-2 py-1.5 text-[11px] text-muted-foreground">
              Some consoles did not answer in time; their results are missing.
            </output>
          )}
        </div>
      </dialog>
    </div>
  );
}
