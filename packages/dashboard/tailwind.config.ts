import type { Config } from 'tailwindcss';

/**
 * Reference a token from `src/app/index.css` (whose values come from AVIARY-UI.md). Nothing in this
 * file may hard-code a colour — the CSS file is the only place a hex is allowed to appear.
 *
 * The indirection through a FUNCTION is not decoration. Tailwind 3 cannot apply an opacity modifier
 * to an arbitrary `var()` colour, so `bg-[var(--accent)]/10` compiled to nothing at all: no rule was
 * emitted, and a missing background looks exactly like a background that was meant to be absent.
 * Every tinted surface in this console — the active nav pill, the Approve/Reject buttons, the
 * failure panels' borders — was rendering untinted and no one could tell. Declaring the colour as a
 * function is what makes Tailwind hand us the modifier; `color-mix` turns it into the intended tint.
 */
function token(name: string) {
  return ({ opacityValue }: { opacityValue?: string | undefined }): string =>
    opacityValue === undefined
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;
}

export default {
  content: ['./index.html', './preview.html', './src/app/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      /**
       * shadcn's semantic vocabulary on the left, Aviary tokens on the right, so a primitive pasted
       * straight out of shadcn renders in this console's palette rather than shadcn's slate.
       *
       * Two mappings deserve a note, because guessing them wrong is how a vendored component ends up
       * screaming:
       *  - shadcn's `accent` is the SUBTLE HOVER SURFACE, not a brand colour. Aviary's `--accent` IS
       *    the brand colour. So `accent` gets `--panel-2`, and the brand hue is `brand`.
       *  - shadcn's `muted` is likewise a surface, and `muted-foreground` is the dim text. Aviary's
       *    `--muted` is the dim text, so it is `muted-foreground`.
       */
      colors: {
        background: token('--bg'),
        foreground: token('--text'),
        card: { DEFAULT: token('--panel'), foreground: token('--text') },
        popover: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        secondary: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        muted: { DEFAULT: token('--panel-2'), foreground: token('--muted') },
        accent: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        destructive: { DEFAULT: token('--bad'), foreground: token('--bg') },
        border: token('--line'),
        input: token('--line'),
        ring: token('--accent'),

        /**
         * The brand hue, under its own name. `primary` resolves to the same token because that IS
         * what shadcn's `primary` means; the alias exists so vendored shadcn source works untouched,
         * while this console's own code says `brand` and cannot be confused with `accent`.
         */
        brand: token('--accent'),
        primary: { DEFAULT: token('--accent'), foreground: token('--bg') },

        /* Aviary-only. No shadcn equivalent, so no name to collide with. */
        panel: { DEFAULT: token('--panel'), 2: token('--panel-2') },
        line: { DEFAULT: token('--line'), soft: token('--line-soft') },
        good: token('--good'),
        warn: token('--warn'),
        bad: token('--bad'),
        live: token('--live'),
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  /**
   * No animation plugin. Base UI drives enter/exit with `data-starting-style` / `data-ending-style`
   * on a plain CSS transition, so the console's overlays animate with `transition-*` utilities it
   * already has — an animation plugin would only be there to serve Radix's `data-state` classes.
   */
  plugins: [],
} satisfies Config;
