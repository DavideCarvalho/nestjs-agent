import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

/**
 * No `refetchInterval`, and no `refetchOnWindowFocus: false`.
 *
 * The old defaults polled every mounted query every five seconds and never refetched on focus,
 * which is the wrong way round for an ops console: it hammered the read-model for nobody while a
 * tab sat in the background, and made no promise at all about being fresh when someone actually
 * looked. Freshness is expressed per query as `staleTime` now (see `STALE` in `use-governance.ts`),
 * and react-query's own focus refetch — which only refires STALE queries — is what makes the
 * numbers current the moment an operator comes back to the tab.
 *
 * `retry: 1` stays: one automatic retry hides a blip, and anything past that just delays telling
 * the operator that the read is failing.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
