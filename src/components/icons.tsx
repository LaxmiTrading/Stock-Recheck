/**
 * Icon set — specification sections 35 and 36.
 *
 * Every icon is a 24×24 stroke drawing that inherits `currentColor` and scales
 * from its `size` prop, so it always matches the colour and weight of the text
 * beside it.
 *
 * This replaces the emoji and typographic glyphs used previously. Emoji are a
 * poor fit for a status UI: they render as full-colour bitmaps that ignore the
 * surrounding colour (so a "danger" emoji stays yellow inside red text), they
 * are drawn differently on every platform, they sit on an inconsistent
 * baseline, and several — ☑ ◐ ○ ✕ — fall back to a different font entirely on
 * Windows, which is where this application is used.
 *
 * Icons are decorative by default and are marked `aria-hidden`, because in this
 * codebase every icon sits next to a real text label (section 35: status is
 * never carried by colour or glyph alone). Pass `title` only when an icon is
 * the entire content of a control and nothing else names it.
 */

import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface IconProps {
  /** Edge length in px. Defaults to 16 — the right size beside 14px body text. */
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Supply only when the icon is the sole accessible content of a control. */
  title?: string;
}

function Icon({
  size = 16,
  strokeWidth = 1.75,
  className,
  title,
  children,
}: IconProps & { children: ReactNode }): React.JSX.Element {
  const labelled = title !== undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-label={title}
      className={clsx('shrink-0', className)}
    >
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------- navigation -- */

export function ArrowLeftIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </Icon>
  );
}

export function ArrowUpIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </Icon>
  );
}

export function ArrowDownIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m15 6-6 6 6 6" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  );
}

export function MenuIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Icon>
  );
}

export function ExternalLinkIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </Icon>
  );
}

/* ----------------------------------------------------------------- status -- */

/** Neutral / not started. */
export function CircleIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
    </Icon>
  );
}

/**
 * In progress. A full ring at reduced opacity with a solid quarter arc drawn
 * over it reads as "partly done" at 12px, which a half-filled disc does not.
 */
export function ProgressIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" opacity="0.35" />
      <path d="M12 3a9 9 0 0 1 9 9" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

export function CheckCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </Icon>
  );
}

export function AlertTriangleIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M10.3 4.3 2.6 17.6a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 17.2h.01" />
    </Icon>
  );
}

export function XCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11.5v5" />
      <path d="M12 8h.01" />
    </Icon>
  );
}

/* ------------------------------------------------------------------ domain -- */

export function ClipboardCheckIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="8" y="2.5" width="8" height="4" rx="1" />
      <path d="M16 4.5h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2" />
      <path d="m9.5 13.5 2 2 3.5-4" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  );
}

export function UserIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.1 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H2.8a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V2.8a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </Icon>
  );
}

export function ScrollTextIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 21h11a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M14.5 8h-4" />
      <path d="M14.5 12h-4" />
    </Icon>
  );
}

export function PackageIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
      <path d="m7.5 4.3 9 5.2" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </Icon>
  );
}

export function LockIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 21h14" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3.5v6h-6" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

export function CalendarIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </Icon>
  );
}

export function FileSpreadsheetIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
      <path d="M8.5 12.5h7" />
      <path d="M8.5 16.5h7" />
      <path d="M12 12.5v4" />
    </Icon>
  );
}

export function ClipboardTextIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="8" y="2.5" width="8" height="4" rx="1" />
      <path d="M16 4.5h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2" />
      <path d="M8.5 12h7" />
      <path d="M8.5 16h4" />
    </Icon>
  );
}

export function PencilIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12.5 5.5 18 11" />
      <path d="M15.7 2.3a2.4 2.4 0 0 1 3.4 3.4L7.5 17.4l-4.5 1.1 1.1-4.5Z" />
    </Icon>
  );
}

export function LayersIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </Icon>
  );
}
