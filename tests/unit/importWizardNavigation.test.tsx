// @vitest-environment jsdom

/**
 * IMPORT WIZARD NAVIGATION — specification section 11.
 *
 * Regression cover for a shipped defect: `SourcePage` is itself the `source`
 * route, so a BARE relative target (`navigate('excel/upload')`) resolved
 * against `/app/rechecks/new/source` and produced
 * `/app/rechecks/new/source/excel/upload`. That matches no route, fell through
 * to the `*` catch-all, and silently returned the user to the dashboard — both
 * source buttons appeared to do nothing.
 *
 * The route tree below mirrors the real nesting in `src/app/routes.tsx`,
 * including a catch-all, so the exact failure is reproduced rather than
 * approximated.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import SourcePage from '@/features/imports/SourcePage';
import { ImportWizardProvider } from '@/features/imports/ImportWizardContext';

afterEach(cleanup);

const CATCH_ALL = 'CATCH-ALL — user was bounced out of the wizard';

function renderWizard(): void {
  render(
    <MemoryRouter initialEntries={['/app/rechecks/new/source']}>
      <ImportWizardProvider>
        <Routes>
          <Route path="/app/rechecks" element={<p>{CATCH_ALL}</p>} />
          <Route path="/app/rechecks/new" element={<Outlet />}>
            <Route path="source" element={<SourcePage />} />
            <Route path="excel">
              <Route path="upload" element={<p>EXCEL UPLOAD STEP</p>} />
            </Route>
            <Route path="text">
              <Route path="entry" element={<p>TEXT ENTRY STEP</p>} />
            </Route>
          </Route>
          <Route path="*" element={<p>{CATCH_ALL}</p>} />
        </Routes>
      </ImportWizardProvider>
    </MemoryRouter>,
  );
}

describe('import wizard source selection', () => {
  it('sends "Choose Excel" to the Excel upload step', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole('button', { name: /choose excel/i }));

    expect(screen.getByText('EXCEL UPLOAD STEP')).toBeDefined();
    expect(screen.queryByText(CATCH_ALL)).toBeNull();
  });

  it('sends "Paste SKU List" to the text entry step', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole('button', { name: /paste sku list/i }));

    expect(screen.getByText('TEXT ENTRY STEP')).toBeDefined();
    expect(screen.queryByText(CATCH_ALL)).toBeNull();
  });

  it('never resolves a source choice underneath the source route itself', async () => {
    // The precise shape of the original bug: a path nested one level too deep.
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole('button', { name: /choose excel/i }));

    // If the bare-relative form ever returns, this is what renders instead.
    expect(screen.queryByText(CATCH_ALL)).toBeNull();
    expect(screen.queryByRole('button', { name: /choose excel/i })).toBeNull();
  });
});
