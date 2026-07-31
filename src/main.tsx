import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProviders } from './app/providers';
import { AppRoutes } from './app/routes';
import './styles/index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Root container #root was not found in index.html');

/**
 * URL prefix every route sits under, taken from the same build-time `base` as
 * the assets (vite.config.ts) so the two can never drift apart.
 *
 * '/' on Netlify and a custom domain; '/Stock-Recheck/' on a GitHub Pages
 * project site. Without it the router would treat '/Stock-Recheck/rechecks' as
 * an unknown path and render the not-found screen for every real page.
 *
 * React Router wants no trailing slash, while Vite's BASE_URL always has one.
 */
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/+$/, '');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename={ROUTER_BASENAME}>
      <AppProviders>
        <AppRoutes />
      </AppProviders>
    </BrowserRouter>
  </StrictMode>,
);
