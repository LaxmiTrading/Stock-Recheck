/**
 * Accessible UI primitives — specification sections 35 and 36.
 *
 * Shared rules baked in here rather than repeated per screen:
 *   - status is never communicated by colour alone (icon + text always present)
 *   - minimum 44px touch targets on interactive controls
 *   - visible focus states inherited from the base stylesheet
 *   - errors are programmatically associated with their field
 */

import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link as RouterLink } from 'react-router-dom';
import clsx from 'clsx';
import type { StatusTone } from '@/domain/status';
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  CloseIcon,
  MinusIcon,
  PackageIcon,
  ProgressIcon,
  XCircleIcon,
  type IconProps,
} from './icons';

/* ---------------------------------------------------------------- Button -- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingText?: string;
  fullWidth?: boolean;
  icon?: ReactNode;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // The gradient + inset highlight is what gives the primary action its raised,
  // Zoho-like weight; `brand-gradient` carries its own hover state.
  primary:
    'brand-gradient text-white shadow-[0_1px_2px_rgba(16,24,40,0.12),inset_0_1px_0_rgba(255,255,255,0.18)] disabled:bg-none disabled:bg-[var(--color-border-strong)] disabled:shadow-none',
  secondary:
    'bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border-strong)] hover:bg-[var(--color-row-hover)]',
  /*
   * Ghost = no background until hover, but FULL-CONTRAST text.
   *
   * It previously used `--color-ink-muted` (#697a92), which is 4.38:1 on the
   * white surface — under the 4.5:1 WCAG AA minimum for normal text, and close
   * to the 2.22:1 that `disabled:opacity-60` produces. The result was that
   * enabled ghost buttons (Sign out, the back links) read as greyed out.
   * Tertiary weight now comes from the absent background alone, which leaves
   * the disabled state unambiguous.
   */
  ghost: 'bg-transparent text-[var(--color-ink)] hover:bg-[var(--color-row-hover)]',
  danger:
    'bg-[var(--color-danger)] text-white hover:opacity-90 shadow-[0_1px_2px_rgba(16,24,40,0.12)]',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  // min-h keeps every control at or above the 44px touch target (section 36).
  sm: 'text-sm px-3 min-h-[36px]',
  md: 'text-sm px-4 min-h-[44px]',
  lg: 'text-base px-6 min-h-[52px] font-semibold',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingText,
  fullWidth = false,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
    >
      {loading ? <Spinner size={16} /> : icon}
      {/*
        * Omitted entirely for an icon-only button. An empty <span> still
        * participates in the flex row, so `gap-2` would add 8px of dead space
        * beside the icon and push it off-centre.
        */}
      {(children !== undefined || loading) && (
        <span>{loading && loadingText !== undefined ? loadingText : children}</span>
      )}
    </button>
  );
}

/**
 * A navigation link that LOOKS like a button.
 *
 * Never nest an anchor inside a <button>: it produces invalid HTML and two
 * conflicting interactive roles for keyboard and screen-reader users. Use this
 * whenever the action is "go somewhere" rather than "do something".
 */
export function LinkButton({
  to,
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  icon,
  children,
  className,
  ...rest
}: {
  to: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<typeof RouterLink>, 'to' | 'className'>): React.JSX.Element {
  return (
    <RouterLink
      {...rest}
      to={to}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium no-underline transition-colors',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
    >
      {icon}
      <span>{children}</span>
    </RouterLink>
  );
}

/* --------------------------------------------------------------- Spinner -- */

export function Spinner({ size = 20, label }: { size?: number; label?: string }): React.JSX.Element {
  return (
    <span role="status" aria-live="polite">
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="animate-spin"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only-focusable absolute">{label ?? 'Loading'}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ Card -- */

export function Card({
  children,
  className,
  as: Component = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}): React.JSX.Element {
  return (
    <Component
      className={clsx(
        'rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4',
        'shadow-[var(--shadow-card)]',
        className,
      )}
    >
      {children}
    </Component>
  );
}

export function CardTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <h3 className="text-sm font-semibold text-[var(--color-ink-muted)]">{children}</h3>;
}

/** Dashboard / progress metric tile. */
export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: StatusTone;
}): React.JSX.Element {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
        {label}
      </span>
      <span className={clsx('tabular text-2xl font-semibold', TONE_TEXT[tone])}>{value}</span>
      {hint !== undefined && (
        <span className="text-xs text-[var(--color-ink-subtle)]">{hint}</span>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- Badge -- */

const TONE_BG: Record<StatusTone, string> = {
  neutral: 'bg-[var(--color-neutral-bg)] text-[var(--color-neutral)]',
  info: 'bg-[var(--color-info-bg)] text-[var(--color-info)]',
  success: 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
  warning: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  muted: 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-subtle)]',
};

const TONE_TEXT: Record<StatusTone, string> = {
  neutral: 'text-[var(--color-ink)]',
  info: 'text-[var(--color-info)]',
  success: 'text-[var(--color-success)]',
  warning: 'text-[var(--color-warning)]',
  danger: 'text-[var(--color-danger)]',
  muted: 'text-[var(--color-ink-subtle)]',
};

/**
 * Section 35/36: every badge carries an icon AND a text label, so status is
 * never conveyed by colour alone.
 */
const TONE_ICON: Record<StatusTone, (props: IconProps) => React.JSX.Element> = {
  neutral: CircleIcon,
  info: ProgressIcon,
  success: CheckCircleIcon,
  warning: AlertTriangleIcon,
  danger: XCircleIcon,
  muted: MinusIcon,
};

/** The status icon for a tone, at the weight badges and notices expect. */
export function ToneIcon({
  tone,
  size = 14,
  className,
}: {
  tone: StatusTone;
  size?: number;
  className?: string;
}): React.JSX.Element {
  const Glyph = TONE_ICON[tone];
  return <Glyph size={size} strokeWidth={2} className={className} />;
}

export function Badge({
  tone = 'neutral',
  children,
  icon,
}: {
  tone?: StatusTone;
  children: ReactNode;
  /** Overrides the tone's default icon. Pass `null` for a label-only badge. */
  icon?: ReactNode | null;
}): React.JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium',
        TONE_BG[tone],
      )}
    >
      {icon === undefined ? <ToneIcon tone={tone} /> : icon}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ form fields */

interface FieldWrapperProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (ids: { inputId: string; describedBy: string | undefined }) => ReactNode;
}

/** Associates label, hint and error with the control (section 36). */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: FieldWrapperProps): React.JSX.Element {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy =
    [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-[var(--color-ink)]">
        {label}
        {required === true && (
          <span className="ml-1 text-[var(--color-danger)]" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-[var(--color-ink-subtle)]">
          {hint}
        </p>
      )}
      {children({ inputId, describedBy })}
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-xs font-medium text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL_CLASS =
  'w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2.5 text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] disabled:opacity-60 min-h-[44px]';

/**
 * Ref-forwarding is required: the counting screen must programmatically focus
 * and select the scanner input after every scan (section 21).
 */
export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { error?: boolean }
>(function TextInput({ error, className, ...rest }, ref) {
  return (
    <input
      {...rest}
      ref={ref}
      aria-invalid={error === true || undefined}
      className={clsx(CONTROL_CLASS, error === true && 'border-[var(--color-danger)]', className)}
    />
  );
});

export function TextArea({
  error,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: boolean }): React.JSX.Element {
  return (
    <textarea
      {...rest}
      aria-invalid={error === true || undefined}
      className={clsx(CONTROL_CLASS, error === true && 'border-[var(--color-danger)]', className)}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select {...rest} className={clsx(CONTROL_CLASS, className)}>
      {children}
    </select>
  );
}

export function Checkbox({
  label,
  description,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  description?: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        {...rest}
        id={id}
        type="checkbox"
        className="mt-1 h-5 w-5 shrink-0 rounded border-[var(--color-border-strong)] accent-[var(--color-brand)]"
      />
      <label htmlFor={id} className="text-sm text-[var(--color-ink)]">
        {label}
        {description !== undefined && (
          <span className="mt-0.5 block text-xs text-[var(--color-ink-subtle)]">{description}</span>
        )}
      </label>
    </div>
  );
}

/* --------------------------------------------------------- overlay layer -- */

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus trapping, Escape-to-close and focus restoration for an overlay
 * (section 36). Shared by Dialog and Drawer so the two cannot drift apart.
 *
 * `onClose` is held in a ref and deliberately kept OUT of the dependency array.
 * Every caller passes an inline arrow (`onClose={() => setOpen(false)}`) whose
 * identity changes on each render; with it in the array the effect tore down
 * and re-ran on every render of the parent, and the setup path re-focuses the
 * first focusable element. The visible symptom was focus jumping back to the
 * first control on each keystroke in an overlay containing a text field —
 * which is exactly what the workspace's "Cancel Recheck" reason box is.
 */
function useOverlayBehaviour(
  open: boolean,
  onClose: () => void,
  panelRef: React.RefObject<HTMLDivElement | null>,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || panel === null) return;

      const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Restore focus to whatever opened the overlay.
      previouslyFocused?.focus();
    };
  }, [open, panelRef]);
}

/**
 * Modal dialog with focus trapping, Escape-to-close and focus restoration
 * (section 36).
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  tone = 'neutral',
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  tone?: StatusTone;
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useOverlayBehaviour(open, onClose, panelRef);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:rounded-2xl"
      >
        <h2 id={titleId} className={clsx('text-lg font-semibold', TONE_TEXT[tone])}>
          {title}
        </h2>
        {description !== undefined && (
          <div className="mt-2 text-sm text-[var(--color-ink-muted)]">{description}</div>
        )}
        {children !== undefined && <div className="mt-4">{children}</div>}
        {footer !== undefined && (
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Drawer -- */

/**
 * Right-hand detail panel.
 *
 * Details open beside the list rather than replacing it, so the operator keeps
 * their place: the filter chips, the scroll position and the surrounding rows
 * all survive, and closing the panel costs nothing. Navigating to a separate
 * page for a read-only summary threw all of that away and made "go back" the
 * only route to the next row.
 *
 * Below `sm` the viewport is too narrow for a side-by-side reading, so the same
 * panel becomes a near-full-screen sheet — the content and behaviour are
 * identical, only the geometry changes.
 *
 * `footer` is pinned to the bottom of the panel and does not scroll with the
 * body, which is what keeps the primary action reachable on a long summary.
 */
export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'md' | 'lg';
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useOverlayBehaviour(open, onClose, panelRef);

  if (!open) return null;

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex justify-end bg-black/40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={clsx(
          'animate-slide-in-right flex h-full w-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-overlay)]',
          width === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <header className="flex items-start gap-3 border-b border-[var(--color-border)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-base font-semibold">
              {title}
            </h2>
            {subtitle !== undefined && (
              <div className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{subtitle}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="-mr-1 flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg text-[var(--color-ink-muted)] hover:bg-[var(--color-row-hover)]"
          >
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer !== undefined && (
          <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Empty/Error */

export function EmptyState({
  title,
  message,
  action,
  icon,
}: {
  title: string;
  message: string;
  action?: ReactNode;
  /** An icon element. Defaults to a package glyph. */
  icon?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-surface-sunken)] text-[var(--color-ink-subtle)]">
        {icon ?? <PackageIcon size={22} />}
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-[var(--color-ink-muted)]">{message}</p>
      {/* Section 37: every empty state offers a next action. */}
      {action}
    </div>
  );
}

export function ErrorState({
  title = 'Something needs attention',
  message,
  correlationId,
  action,
}: {
  title?: string;
  message: string;
  correlationId?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-4"
    >
      <div className="flex items-center gap-2 text-[var(--color-danger)]">
        <XCircleIcon size={16} strokeWidth={2} />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="text-sm text-[var(--color-ink)]">{message}</p>
      {/* Section 37: always surface the correlation ID for server failures. */}
      {correlationId !== undefined && (
        <p className="font-mono text-xs text-[var(--color-ink-subtle)]">
          Reference: {correlationId}
        </p>
      )}
      {action}
    </div>
  );
}

export function InlineNotice({
  tone = 'info',
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={clsx(
        'flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm',
        TONE_BG[tone],
      )}
    >
      <ToneIcon tone={tone} size={16} className="mt-0.5" />
      <div>{children}</div>
    </div>
  );
}

/* ----------------------------------------------------------- ProgressBar -- */

export function ProgressBar({
  value,
  max = 100,
  label,
}: {
  value: number;
  max?: number;
  label: string;
}): React.JSX.Element {
  const percentage = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs text-[var(--color-ink-muted)]">
        <span>{label}</span>
        <span className="tabular">{percentage}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]"
      >
        <div
          className="h-full rounded-full bg-[var(--color-brand)] transition-[width] duration-300"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

/* --------------------------------------------------------- StepIndicator -- */

export function StepIndicator({
  steps,
  currentIndex,
}: {
  steps: readonly string[];
  currentIndex: number;
}): React.JSX.Element {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" aria-label="Progress">
      {steps.map((step, index) => {
        const state =
          index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming';
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              aria-current={state === 'current' ? 'step' : undefined}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium',
                state === 'complete' && 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
                state === 'current' && 'bg-[var(--color-brand)] text-white',
                state === 'upcoming' && 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-subtle)]',
              )}
            >
              {state === 'complete' ? (
                <CheckIcon size={13} strokeWidth={2.5} />
              ) : (
                <span aria-hidden="true" className="tabular">
                  {index + 1}
                </span>
              )}
              {step}
            </span>
            {index < steps.length - 1 && (
              <span className="text-[var(--color-ink-subtle)]" aria-hidden="true">
                ›
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ Tabs -- */

export function Tabs<Value extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { value: Value; label: string; count?: number }[];
  value: Value;
  onChange: (value: Value) => void;
}): React.JSX.Element {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-[var(--color-border)]">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          type="button"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={clsx(
            'min-h-[44px] rounded-t-lg px-4 text-sm font-medium transition-colors',
            tab.value === value
              ? 'border-b-2 border-[var(--color-brand)] text-[var(--color-brand)]'
              : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]',
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="tabular ml-1.5 text-xs text-[var(--color-ink-subtle)]">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Pagination -- */

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions: readonly number[];
}): React.JSX.Element {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-col items-center justify-between gap-3 py-3 sm:flex-row"
    >
      <p className="tabular text-sm text-[var(--color-ink-muted)]">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          Rows
          <Select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="w-auto min-h-[36px] py-1"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </label>
        <Button size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          Previous
        </Button>
        <span className="tabular text-sm">
          {page} / {Math.max(1, totalPages)}
        </span>
        <Button size="sm" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
          Next
        </Button>
      </div>
    </nav>
  );
}

/* ----------------------------------------------------------------- Toast -- */

export interface ToastMessage {
  id: string;
  tone: StatusTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  push: (toast: Omit<ToastMessage, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

export { ToastContext, TONE_BG, TONE_TEXT };
