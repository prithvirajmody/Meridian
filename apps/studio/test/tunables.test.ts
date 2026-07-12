/**
 * 6E panel logic, headless: the session copy round-trips through the store
 * commands, reset restores the canonical frozen ADR defaults, values sanitize
 * against the spec windows, and the navigator picks a tunables edit up on the
 * *next* transition (real pipeline, deterministic ManualClock) — no reload,
 * no rebuild.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MAX_TRANSITION_MS, NAV_TUNABLE_DEFAULTS } from '@meridian/navigation';
import { StudioSession } from '../src/studio-session.js';
import type { StudioNavigator } from '../src/navigation/studio-navigator.js';
import { ManualClock } from '../src/transition/clock.js';
import { sanitizeTunable, TUNABLE_SPECS } from '../src/tunable-specs.js';
import { createStudioStore, StudioStoreCommands } from '../src/store.js';

const CORPUS_ROOT = fileURLToPath(new URL('../../../fixtures/corpora/markdown/', import.meta.url));
const CENTER = { x: 500, y: 400 };

describe('the session copy (store slice)', () => {
  it('boots as the canonical frozen defaults object', () => {
    const store = createStudioStore();
    expect(store.getState().tunables).toBe(NAV_TUNABLE_DEFAULTS);
  });

  it('edits round-trip without touching the defaults module or other keys', () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    commands.setTunable('baseTransitionMs', 120);
    commands.setTunable('anchorSnapFactor', 1.5);
    expect(store.getState().tunables.baseTransitionMs).toBe(120);
    expect(store.getState().tunables.anchorSnapFactor).toBe(1.5);
    expect(store.getState().tunables.crossfadeMs).toBe(NAV_TUNABLE_DEFAULTS.crossfadeMs);
    // The canonical defaults never move (frozen single source).
    expect(NAV_TUNABLE_DEFAULTS.baseTransitionMs).toBe(240);
    expect(Object.isFrozen(NAV_TUNABLE_DEFAULTS)).toBe(true);
  });

  it('reset restores the ADR defaults exactly', () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    for (const spec of TUNABLE_SPECS) commands.setTunable(spec.key, spec.min);
    expect(store.getState().tunables).not.toEqual(NAV_TUNABLE_DEFAULTS);
    commands.resetTunables();
    expect(store.getState().tunables).toBe(NAV_TUNABLE_DEFAULTS);
  });

  it('sanitizes: non-finite ignored, out-of-window clamped to the spec bounds', () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    commands.setTunable('baseTransitionMs', Number.NaN);
    commands.setTunable('crossfadeMs', Number.POSITIVE_INFINITY);
    expect(store.getState().tunables).toBe(NAV_TUNABLE_DEFAULTS); // untouched

    commands.setTunable('baseTransitionMs', 99_999);
    expect(store.getState().tunables.baseTransitionMs).toBe(MAX_TRANSITION_MS);
    commands.setTunable('keyZoomFactor', 0); // would invert/deadlock the gesture
    expect(store.getState().tunables.keyZoomFactor).toBe(1.01);
    commands.setTunable('stabilityDegradeFloor', -3);
    expect(store.getState().tunables.stabilityDegradeFloor).toBe(0);

    expect(sanitizeTunable('overzoomMax', 0.1)).toBe(1);
    expect(sanitizeTunable('overzoomMax', Number.NaN)).toBeUndefined();
  });

  it('spec table covers every tunable key exactly once (panel = full surface)', () => {
    const specKeys = TUNABLE_SPECS.map((spec) => spec.key).sort();
    expect(specKeys).toEqual(Object.keys(NAV_TUNABLE_DEFAULTS).sort());
    expect(new Set(specKeys).size).toBe(TUNABLE_SPECS.length);
  });
});

describe('the navigator reads the session copy on the next transition', () => {
  async function open(corpus = 'basic.md') {
    const store = createStudioStore();
    const clock = new ManualClock();
    const session = new StudioSession(store, { clock, viewportProvider: () => ({ width: 1000, height: 800 }) });
    await session.openText(corpus, await readFile(`${CORPUS_ROOT}${corpus}`, 'utf8'));
    const nav = session.nav();
    if (nav === null) throw new Error(`navigator failed to boot: ${store.getState().message}`);
    const waitForFlight = async (target: StudioNavigator): Promise<void> => {
      await vi.waitFor(() => {
        if (!target.inFlight()) throw new Error('no flight yet');
      });
    };
    const settle = async (target: StudioNavigator): Promise<void> => {
      await waitForFlight(target);
      await vi.waitFor(() => {
        if (!target.inFlight()) return;
        clock.advance(50);
        target.tick();
        if (target.inFlight()) throw new Error('still flying');
      });
    };
    return { store, session, clock, nav, settle, waitForFlight };
  }

  it('an edited BASE_TRANSITION_MS lands on the next transition without reload', async () => {
    const h = await open();
    try {
      new StudioStoreCommands(h.store).setTunable('baseTransitionMs', 120);
      h.nav.wheelZoom(60, CENTER); // threshold-crossing zoom → one transition
      await h.waitForFlight(h.nav);
      expect(h.nav.telemetry().at(-1)!.durationMs).toBe(120);

      // The flight really ends on the tuned clock horizon: 120ms in, settled
      // (the ADR default 240 would still be mid-flight here).
      h.clock.advance(120);
      h.nav.tick();
      expect(h.nav.inFlight()).toBe(false);
    } finally {
      await h.session.destroy();
    }
  });

  it('reset mid-session: the following transition is back on the ADR duration', async () => {
    const h = await open();
    try {
      const commands = new StudioStoreCommands(h.store);
      commands.setTunable('baseTransitionMs', 120);
      h.nav.wheelZoom(60, CENTER);
      await h.settle(h.nav);
      expect(h.nav.telemetry().at(-1)!.durationMs).toBe(120);

      commands.resetTunables();
      h.nav.wheelZoom(1 / 60, CENTER); // back out — a fresh transition
      await h.settle(h.nav);
      expect(h.nav.telemetry().at(-1)!.durationMs).toBe(NAV_TUNABLE_DEFAULTS.baseTransitionMs);
    } finally {
      await h.session.destroy();
    }
  });

  it('a tuned MAX_ANIMATED_NODES=0 degrades the next transition to crossfade', async () => {
    const h = await open();
    try {
      new StudioStoreCommands(h.store).setTunable('maxAnimatedNodes', 0);
      h.nav.wheelZoom(60, CENTER);
      await h.settle(h.nav);
      const record = h.nav.telemetry().at(-1)!;
      expect(record.mode).toBe('crossfade');
      expect(record.degradeTriggers).toContain('animated-node-budget');
      expect(record.durationMs).toBe(NAV_TUNABLE_DEFAULTS.crossfadeMs);
    } finally {
      await h.session.destroy();
    }
  });
});
