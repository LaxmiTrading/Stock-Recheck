/**
 * Route table — specification section 7.
 *
 * Implements the full documented navigation depth. Import-wizard steps are
 * nested routes under /app/rechecks/new so the browser Back button walks the
 * wizard exactly as the operator expects.
 */

import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { RedirectIfAuthenticated, RequireAdministrator, RequireAuth } from './guards';
import { ForgotPasswordPage, LoginPage } from '@/features/auth/LoginPage';
import { SetPasswordPage } from '@/features/auth/SetPasswordPage';
import { Spinner } from '@/components/ui';

/* Code-splitting keeps the counting screen — the one used under time pressure
   on a phone — small and fast to load. */
const RechecksPage = lazy(() => import('@/features/rechecks/RechecksPage'));
const WorkspacePage = lazy(() => import('@/features/rechecks/WorkspacePage'));
const CountPage = lazy(() => import('@/features/counting/CountPage'));
const MultiCountPage = lazy(() => import('@/features/counting/MultiCountPage'));
const SubmittedItemPage = lazy(() => import('@/features/counting/SubmittedItemPage'));
const SummaryPage = lazy(() => import('@/features/summary/SummaryPage'));
const ProfilePage = lazy(() => import('@/features/profile/ProfilePage'));

const ImportWizardLayout = lazy(() => import('@/features/imports/ImportWizardLayout'));
const SourcePage = lazy(() => import('@/features/imports/SourcePage'));
const ExcelUploadPage = lazy(() => import('@/features/imports/ExcelUploadPage'));
const SheetSelectPage = lazy(() => import('@/features/imports/SheetSelectPage'));
const MappingPage = lazy(() => import('@/features/imports/MappingPage'));
const ExcelPreviewPage = lazy(() => import('@/features/imports/ExcelPreviewPage'));
const TextEntryPage = lazy(() => import('@/features/imports/TextEntryPage'));
const TextPreviewPage = lazy(() => import('@/features/imports/TextPreviewPage'));
const ValidationPage = lazy(() => import('@/features/imports/ValidationPage'));
const ImportResultPage = lazy(() => import('@/features/imports/ImportResultPage'));
const ConfirmPage = lazy(() => import('@/features/imports/ConfirmPage'));

const UsersPage = lazy(() => import('@/features/admin/UsersPage'));
const SettingsLayout = lazy(() => import('@/features/admin/SettingsLayout'));
const GeneralSettings = lazy(() => import('@/features/admin/GeneralSettings'));
const ZohoSettings = lazy(() => import('@/features/admin/ZohoSettings'));
const StockBasisSettings = lazy(() => import('@/features/admin/StockBasisSettings'));
const ClaimRulesSettings = lazy(() => import('@/features/admin/ClaimRulesSettings'));
const ScannerSettings = lazy(() => import('@/features/admin/ScannerSettings'));
const AuditLogPage = lazy(() => import('@/features/admin/AuditLogPage'));

function RouteFallback(): React.JSX.Element {
  return (
    <div className="flex items-center justify-center py-16">
      <Spinner size={28} label="Loading screen" />
    </div>
  );
}

export function AppRoutes(): React.JSX.Element {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* ------------------------------------------------ public routes */}
        <Route
          path="/login"
          element={
            <RedirectIfAuthenticated>
              <LoginPage />
            </RedirectIfAuthenticated>
          }
        />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/accept-invite" element={<SetPasswordPage mode="invite" />} />
        <Route path="/reset-password" element={<SetPasswordPage mode="reset" />} />

        {/* --------------------------------------- authenticated shell */}
        <Route element={<RequireAuth />}>
          <Route path="/app" element={<AppShell />}>
            <Route index element={<Navigate to="/app/rechecks" replace />} />

            {/*
             * Dashboard and History were folded into Rechecks. These redirects
             * keep old bookmarks and in-flight links working rather than
             * bouncing them off the `*` catch-all.
             */}
            <Route path="dashboard" element={<Navigate to="/app/rechecks" replace />} />

            {/* ------------------------------------------ rechecks */}
            <Route path="rechecks">
              <Route index element={<RechecksPage />} />

              {/* Import wizard — administrators only (section 4.5). */}
              <Route element={<RequireAdministrator />}>
                <Route path="new" element={<ImportWizardLayout />}>
                  <Route index element={<Navigate to="source" replace />} />
                  <Route path="source" element={<SourcePage />} />
                  <Route path="excel">
                    <Route index element={<Navigate to="upload" replace />} />
                    <Route path="upload" element={<ExcelUploadPage />} />
                    <Route path="sheet" element={<SheetSelectPage />} />
                    <Route path="mapping" element={<MappingPage />} />
                    <Route path="preview" element={<ExcelPreviewPage />} />
                  </Route>
                  <Route path="text">
                    <Route index element={<Navigate to="entry" replace />} />
                    <Route path="entry" element={<TextEntryPage />} />
                    <Route path="preview" element={<TextPreviewPage />} />
                  </Route>
                  <Route path="validation" element={<ValidationPage />} />
                  <Route path="import-result" element={<ImportResultPage />} />
                  <Route path="confirm" element={<ConfirmPage />} />
                </Route>
              </Route>

              <Route path=":recheckId">
                <Route index element={<Navigate to="workspace" replace />} />
                <Route path="workspace" element={<WorkspacePage />} />
                {/* Multi-item counting: the destination after claiming. The
                    single-item screen below stays reachable by direct link. */}
                <Route path="count" element={<MultiCountPage />} />
                <Route path="items/:itemId/count" element={<CountPage />} />
                <Route path="items/:itemId/submitted" element={<SubmittedItemPage />} />
                <Route path="summary" element={<SummaryPage />} />
                <Route path="export" element={<SummaryPage exportFocus />} />
              </Route>
            </Route>

            {/* History now lives inside Rechecks; a completed Stock Recheck is
                reached through its own summary route. */}
            <Route path="history">
              <Route index element={<Navigate to="/app/rechecks" replace />} />
              <Route path=":recheckId" element={<SummaryPage />} />
            </Route>

            {/* --------------------------------------------- admin */}
            <Route path="admin" element={<RequireAdministrator />}>
              <Route index element={<Navigate to="/app/admin/users" replace />} />
              <Route path="users">
                <Route index element={<UsersPage />} />
                <Route path=":userId" element={<UsersPage />} />
              </Route>
              <Route path="settings" element={<SettingsLayout />}>
                <Route index element={<Navigate to="general" replace />} />
                <Route path="general" element={<GeneralSettings />} />
                <Route path="zoho" element={<ZohoSettings />} />
                <Route path="stock-basis" element={<StockBasisSettings />} />
                <Route path="claim-rules" element={<ClaimRulesSettings />} />
                <Route path="scanner" element={<ScannerSettings />} />
              </Route>
              <Route path="audit-log" element={<AuditLogPage />} />
            </Route>

            <Route path="profile" element={<ProfilePage />} />
          </Route>
        </Route>

        <Route path="/" element={<Navigate to="/app/rechecks" replace />} />
        <Route path="*" element={<Navigate to="/app/rechecks" replace />} />
      </Routes>
    </Suspense>
  );
}
