/**
 * Import wizard shell — specification section 11.
 * Provides the draft context and the step indicator shared by every step.
 */

import { Outlet, useLocation } from 'react-router-dom';
import { Card, StepIndicator } from '@/components/ui';
import {
  ImportWizardProvider,
  stepIndexForPath,
  WIZARD_STEPS,
} from './ImportWizardContext';

export default function ImportWizardLayout(): React.JSX.Element {
  const { pathname } = useLocation();

  return (
    <ImportWizardProvider>
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="space-y-3">
          <h2 className="text-xl font-semibold">Create Stock Recheck</h2>
          <StepIndicator steps={WIZARD_STEPS} currentIndex={stepIndexForPath(pathname)} />
        </header>

        <Card className="p-5">
          <Outlet />
        </Card>

        <p className="text-center text-xs text-[var(--color-ink-subtle)]">
          This application only reads from Zoho Books. No stock, adjustment or document is
          ever created or updated in Zoho.
        </p>
      </div>
    </ImportWizardProvider>
  );
}
