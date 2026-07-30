/**
 * Settings shell with the five sub-sections — specification section 28.
 */

import { NavLink, Outlet } from 'react-router-dom';
import clsx from 'clsx';

const TABS = [
  { to: 'general', label: 'General' },
  { to: 'zoho', label: 'Zoho Integration' },
  { to: 'stock-basis', label: 'Stock Basis' },
  { to: 'claim-rules', label: 'Claim Rules' },
  { to: 'scanner', label: 'Scanner' },
];

export default function SettingsLayout(): React.JSX.Element {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Configuration for imports, counting behaviour and the Zoho connection.
        </p>
      </div>

      <nav aria-label="Settings sections" className="flex flex-wrap gap-1 border-b border-[var(--color-border)]">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              clsx(
                'min-h-[44px] rounded-t-lg px-4 py-2 text-sm font-medium',
                isActive
                  ? 'border-b-2 border-[var(--color-brand)] text-[var(--color-brand)]'
                  : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
