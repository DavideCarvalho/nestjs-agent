import type { SVGProps } from 'react';

/** Crisp 1.7px-stroke line icons — no icon-font dependency, tuned for the console aesthetic. */
const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function DollarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M12 2v20M17 6.5c0-2-2-3.5-5-3.5s-5 1.4-5 3.4c0 4.6 10 2.6 10 7.2 0 2-2 3.4-5 3.4s-5-1.5-5-3.5" />
    </svg>
  );
}
export function ChipIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2" />
    </svg>
  );
}
export function UsersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.5a3 3 0 0 1 0 5.5M21 20c0-2.5-1.5-4.6-3.6-5.5" />
    </svg>
  );
}
export function WrenchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L3 18l3 3 6.5-6.5a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-2.4z" />
    </svg>
  );
}
export function ActivityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    </svg>
  );
}
export function AlertIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M12 3 2 20h20L12 3zM12 10v4M12 17.5v.5" />
    </svg>
  );
}
export function TrendIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M3 17l6-6 4 4 8-8M21 7v5M21 7h-5" />
    </svg>
  );
}

/** The console brand mark — a governed-gateway glyph (a diamond gateway with a routed path). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="ai gateway"
    >
      <title>ai gateway</title>
      <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" opacity={0.35} />
      <circle cx="7" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="17" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M8.6 12h2.2M13.2 12h2.2M12 9.5v5" />
    </svg>
  );
}
