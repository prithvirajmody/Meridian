import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { StudioRuntime, type MeridianStudioTestApi } from './runtime.js';
import './styles.css';

declare global {
  interface Window {
    __MERIDIAN_STUDIO__?: MeridianStudioTestApi;
  }
}

const rootElement = document.querySelector<HTMLElement>('#root');
if (rootElement === null) throw new Error('Meridian Studio root element is missing');

const params = new URLSearchParams(window.location.search);
const runtime = new StudioRuntime(params.get('debug') === '1');
if (params.get('e2e') === '1') window.__MERIDIAN_STUDIO__ = runtime.testApi();

createRoot(rootElement).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
);
