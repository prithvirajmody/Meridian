import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { StudioRuntime, type MeridianStudioTestApi } from './runtime.js';
import type { StorageParityApi } from './storage-parity-harness.js';
import './styles.css';

declare global {
  interface Window {
    __MERIDIAN_STUDIO__?: MeridianStudioTestApi;
    __MERIDIAN_STORAGE_PARITY__?: StorageParityApi;
  }
}

const rootElement = document.querySelector<HTMLElement>('#root');
if (rootElement === null) throw new Error('Meridian Studio root element is missing');

const params = new URLSearchParams(window.location.search);
const runtime = new StudioRuntime(params.get('debug') === '1', {
  // ADR-0023 "time is injected": Playwright boots the deterministic clock so
  // mid-transition screenshot baselines are drivable frame by frame.
  manualClock: params.get('clock') === 'manual',
});
if (params.get('e2e') === '1') {
  window.__MERIDIAN_STUDIO__ = runtime.testApi();
  // The 11D storage-parity harness loads lazily so the sqlite worker chunk
  // never touches ordinary sessions.
  void import('./storage-parity-harness.js').then((m) => {
    window.__MERIDIAN_STORAGE_PARITY__ = m.createStorageParityApi();
  });
}

createRoot(rootElement).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
);
