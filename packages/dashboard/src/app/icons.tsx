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
export function TagIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M20.5 13.5 12.6 21.4a2 2 0 0 1-2.8 0l-6.2-6.2a2 2 0 0 1 0-2.8L11.5 4.4a2 2 0 0 1 1.4-.6H19a1.5 1.5 0 0 1 1.5 1.5v6.8a2 2 0 0 1-.6 1.4z" />
      <circle cx="16.2" cy="7.8" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
export function RetryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15.4-6.4M21 12a9 9 0 0 1-15.4 6.4M3 5v5h5M21 19v-5h-5" />
    </svg>
  );
}
export function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}
export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M4 12.5 9.5 18 20 6" />
    </svg>
  );
}
export function XIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M5 5l14 14M19 5 5 19" />
    </svg>
  );
}
export function InboxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M3 12h4.5l1.5 3h6l1.5-3H21M4 12 5.6 5.8A2 2 0 0 1 7.5 4.3h9a2 2 0 0 1 1.9 1.5L20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
export function ChevronUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="m6 15 6-6 6 6" />
    </svg>
  );
}
export function CalendarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
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
