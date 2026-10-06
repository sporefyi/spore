import { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { Navbar, Footer } from './shared/components/Chrome';
import { LoadingState } from './shared/components/primitives';

const Home = lazy(() => import('./routes/Home'));
const Agents = lazy(() => import('./routes/Agents'));
const Passport = lazy(() => import('./routes/Passport'));
const Market = lazy(() => import('./routes/Market'));
const Protocol = lazy(() => import('./routes/Protocol'));
const Contracts = lazy(() => import('./routes/Contracts'));
const Developers = lazy(() => import('./routes/Developers'));
const Connect = lazy(() => import('./routes/Connect'));
const Live = lazy(() => import('./routes/live/LivePage'));
const Playground = lazy(() => import('./routes/Playground'));
const Leaderboard = lazy(() => import('./routes/Leaderboard'));
const Syndicate = lazy(() => import('./routes/Syndicate'));
const Gpu = lazy(() => import('./routes/Gpu'));

function NotFound() {
  return (
    <div className="mx-auto max-w-3xl px-4 md:px-8 py-24">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        404
      </span>
      <h1 className="display mt-4 text-3xl text-ink">
        Page not found
      </h1>
      <p className="mt-3 text-muted">There is nothing at this address.</p>
      <Link
        to="/"
        className="mt-8 inline-block text-sm text-muted underline underline-offset-4 hover:text-ink"
      >
        Return to the front page
      </Link>
    </div>
  );
}

/* Reset scroll and move focus to the main landmark on route change
   (react-router does neither by itself). Hash navigations are skipped so
   the pages' own hash-scroll handlers (/#ledger, /protocol#score-lab)
   keep working. */
function RouteFocus() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) return;
    window.scrollTo(0, 0);
    const main = document.getElementById('main');
    if (main && !main.hasAttribute('tabindex')) {
      main.setAttribute('tabindex', '-1');
    }
    main?.focus({ preventScroll: true });
  }, [pathname, hash]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <RouteFocus />
      <div className="min-h-screen bg-bg text-ink font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-ink focus:px-3 focus:py-2 focus:text-sm focus:text-bg"
        >
          Skip to content
        </a>
        <Navbar />
        <main id="main">
          <Suspense fallback={<div className="mx-auto max-w-7xl px-4 md:px-8 py-16"><LoadingState label="Loading…" /></div>}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/passport/:agent" element={<Passport />} />
              <Route path="/market" element={<Market />} />
              <Route path="/protocol" element={<Protocol />} />
              <Route path="/contracts" element={<Contracts />} />
              <Route path="/developers" element={<Developers />} />
              <Route path="/connect" element={<Connect />} />
              <Route path="/live" element={<Live />} />
              <Route path="/playground" element={<Playground />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/syndicate" element={<Syndicate />} />
              <Route path="/gpu" element={<Gpu />} />
              <Route path="/passport" element={<Navigate to="/agents" replace />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
