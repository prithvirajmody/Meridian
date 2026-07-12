/**
 * 6D choreography driver, headless: the real pipeline (markdown ingest →
 * op-based store → NavigationController → choreographer → animator) under a
 * deterministic ManualClock. Covers semantic zoom transitions, the ADR-0023
 * retarget-not-queue rule, ADR-0024 drift, drill/breadcrumb flows, ADR-0012
 * overrides, URL round-trips, and the store-mutation-mid-transition replan.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { NodeId } from '@meridian/view-model';
import { StudioSession } from '../src/studio-session.js';
import type { StudioNavigator } from '../src/navigation/studio-navigator.js';
import { ManualClock } from '../src/transition/clock.js';
import { createStudioStore, type StudioStore } from '../src/store.js';

const CORPUS_ROOT = fileURLToPath(new URL('../../../fixtures/corpora/markdown/', import.meta.url));
const VIEWPORT = { width: 1000, height: 800 };
const CENTER = { x: 500, y: 400 };

interface Harness {
  readonly store: StudioStore;
  readonly session: StudioSession;
  readonly clock: ManualClock;
  readonly nav: StudioNavigator;
  settle(): Promise<void>;
  destroy(): Promise<void>;
}

async function open(corpus = 'basic.md'): Promise<Harness> {
  const store = createStudioStore();
  const clock = new ManualClock();
  const session = new StudioSession(store, {
    clock,
    viewportProvider: () => VIEWPORT,
  });
  await session.openText(corpus, await readFile(`${CORPUS_ROOT}${corpus}`, 'utf8'));
  const nav = session.nav();
  if (nav === null) throw new Error(`navigator failed to boot for ${corpus}: ${store.getState().message}`);
  const settle = async (): Promise<void> => {
    await vi.waitFor(() => {
      if (!nav.inFlight()) return;
      clock.advance(50);
      nav.tick();
      if (nav.inFlight()) throw new Error('still flying');
    });
  };
  return { store, session, clock, nav, settle, destroy: () => session.destroy() };
}

async function waitForFlight(nav: StudioNavigator): Promise<void> {
  await vi.waitFor(() => {
    if (!nav.inFlight()) throw new Error('no flight yet');
  });
}

describe('boot', () => {
  it('publishes the nav slice, a single breadcrumb, and a linkable fragment', async () => {
    const h = await open();
    try {
      const nav = h.store.getState().nav;
      expect(nav).not.toBeNull();
      expect(nav!.depth).toBe(1);
      expect(nav!.breadcrumbs).toHaveLength(1);
      expect(nav!.urlFragment.startsWith('#g=')).toBe(true);
      expect(nav!.transition.active).toBe(false);
      expect(h.store.getState().renderModel).not.toBeNull();
    } finally {
      await h.destroy();
    }
  });
});

describe('semantic zoom (ADR-0025 continuous verb)', () => {
  it('a threshold-crossing wheel zoom starts one transition and settles on the manual clock', async () => {
    const h = await open();
    try {
      const before = h.store.getState().renderModel!;
      h.nav.wheelZoom(60, CENTER); // saturates z → finest cut
      await waitForFlight(h.nav);
      expect(h.nav.telemetry()).toHaveLength(1);

      // Mid-flight: the transition is drivable frame by frame on the clock.
      h.clock.advance(100);
      h.nav.tick();
      expect(h.nav.inFlight()).toBe(true);

      await h.settle();
      const record = h.nav.telemetry()[0]!;
      expect(record.settledAtMs).not.toBeNull();
      expect(record.durationMs).toBeLessThanOrEqual(300);
      const after = h.store.getState().renderModel!;
      expect(after.revision).not.toBe(before.revision);
      expect(h.store.getState().nav!.zoom).toBe(1);
    } finally {
      await h.destroy();
    }
  });

  it('holds the ADR-0024 anchor: measured drift is ~0 across the flight', async () => {
    const h = await open();
    try {
      h.nav.wheelZoom(60, { x: 700, y: 300 });
      await waitForFlight(h.nav);
      for (let step = 0; step < 12; step++) {
        h.clock.advance(20);
        h.nav.tick();
      }
      await h.settle();
      const record = h.nav.telemetry()[0]!;
      expect(record.anchored).toBe(true);
      expect(record.maxDriftPx).toBeLessThan(1e-6);
    } finally {
      await h.destroy();
    }
  });

  it('a pure geometric zoom (no threshold crossing) does not start a transition', async () => {
    const h = await open();
    try {
      h.nav.wheelZoom(1.01, CENTER);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.nav.telemetry()).toHaveLength(0);
      expect(h.nav.inFlight()).toBe(false);
    } finally {
      await h.destroy();
    }
  });

  it('retargets — never queues — when a second zoom lands mid-flight (ADR-0023)', async () => {
    const h = await open();
    try {
      h.nav.wheelZoom(60, CENTER);
      await waitForFlight(h.nav);
      h.clock.advance(80);
      h.nav.tick(); // mid-flight
      h.nav.wheelZoom(1 / 60, CENTER); // reverse gesture mid-flight
      await vi.waitFor(() => {
        if (h.nav.telemetry().length < 2) throw new Error('replan pending');
      });
      const records = h.nav.telemetry();
      expect(records[0]!.superseded).toBe(true);
      expect(records[0]!.settledAtMs).toBeNull();
      expect(records[1]!.replannedFromFlight).toBe(true);
      await h.settle();
      expect(h.nav.telemetry()[1]!.settledAtMs).not.toBeNull();
      expect(h.nav.inFlight()).toBe(false);
      // The reverse gesture won: z came back down from saturation.
      expect(h.store.getState().nav!.zoom).toBeLessThan(0.5);
    } finally {
      await h.destroy();
    }
  });
});

describe('expand/collapse in place (ADR-0012 via controller)', () => {
  it('toggling a frontier node transitions and round-trips through the override map', async () => {
    const h = await open();
    try {
      const expandable = h.nav.currentLod().frontier.expandable[0];
      expect(expandable).toBeDefined();
      h.nav.toggleExpand(expandable!);
      await waitForFlight(h.nav);
      await h.settle();
      expect(h.nav.urlFragment()).toContain('ov=');
      const grown = h.store.getState().renderModel!.nodeIds.length;

      h.nav.toggleExpand(expandable!); // undo
      await waitForFlight(h.nav);
      await h.settle();
      expect(h.nav.urlFragment()).not.toContain('ov=');
      expect(h.store.getState().renderModel!.nodeIds.length).toBeLessThan(grown);
    } finally {
      await h.destroy();
    }
  });
});

describe('drill-in / drill-out (ADR-0025 scope verbs)', () => {
  it('drilling a leaf is a located no-detail no-op', async () => {
    const h = await open();
    try {
      const lod = h.nav.currentLod();
      h.nav.wheelZoom(60, CENTER);
      await waitForFlight(h.nav);
      await h.settle();
      const finest = h.nav.currentLod();
      const expandable = new Set(finest.frontier.expandable);
      const leaf = finest.cut.members.find((member) => !expandable.has(member));
      expect(leaf).toBeDefined();
      h.nav.drillInto(leaf!);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.store.getState().nav!.notice?.code).toBe('no-detail');
      expect(h.store.getState().nav!.depth).toBe(1);
      expect(lod).toBeDefined();
    } finally {
      await h.destroy();
    }
  });

  it('drill-in pushes context (breadcrumbs grow) and drill-out restores the saved view exactly', async () => {
    const h = await open();
    try {
      const target = h.nav.currentLod().frontier.expandable[0]!;
      const savedCamera = h.nav.displayedCamera();
      const savedZoom = h.store.getState().nav!.zoom;

      h.nav.drillInto(target);
      await waitForFlight(h.nav);
      await h.settle();
      const drilled = h.store.getState().nav!;
      expect(drilled.depth).toBe(2);
      expect(drilled.breadcrumbs).toHaveLength(2);
      expect(drilled.zoom).toBe(0); // ADR-0025: enter at z = 0 of the detail chain
      expect(drilled.urlFragment).toContain('ctx=');

      h.nav.drillOut();
      await waitForFlight(h.nav);
      await h.settle();
      const restored = h.store.getState().nav!;
      expect(restored.depth).toBe(1);
      expect(restored.zoom).toBeCloseTo(savedZoom, 10);
      const camera = h.nav.displayedCamera();
      expect(camera.center.x).toBeCloseTo(savedCamera.center.x, 6);
      expect(camera.center.y).toBeCloseTo(savedCamera.center.y, 6);
      expect(camera.scale).toBeCloseTo(savedCamera.scale, 6);
    } finally {
      await h.destroy();
    }
  });
});

describe('search & fly-to (6C port wired)', () => {
  it('finds labels through the store tokenizer and flies without drilling', async () => {
    const h = await open();
    try {
      const anyNode = h.nav.currentLod().cut.members[0]!;
      const hits = h.nav.search(labelQueryFor(h, anyNode));
      expect(hits.length).toBeGreaterThan(0);
      const depthBefore = h.store.getState().nav!.depth;
      h.nav.flyTo(hits[0]!.node as NodeId);
      await waitForFlight(h.nav);
      await h.settle();
      expect(h.store.getState().nav!.focus).toBe(hits[0]!.node);
      expect(h.store.getState().nav!.depth).toBe(depthBefore); // never drills
    } finally {
      await h.destroy();
    }
  });
});

function labelQueryFor(h: Harness, node: NodeId): string {
  // Use the first token of the node's own label so the query always hits.
  const raw = h.store.getState().renderModel!;
  const index = raw.nodeIds.indexOf(node);
  const text = raw.labelTable[raw.labelRefs[index]!] ?? '';
  const token = text.split(/[^\p{L}\p{N}]+/u).find((part) => part.length > 0);
  return token ?? 'a';
}

describe('URL state (ADR-0025 exact restoration)', () => {
  it('round-trips the view through the fragment into a fresh session', async () => {
    const h = await open();
    try {
      h.nav.wheelZoom(60, { x: 640, y: 320 });
      await waitForFlight(h.nav);
      await h.settle();
      const fragment = h.nav.urlFragment();
      const cameraA = h.nav.displayedCamera();
      const membersA = [...h.nav.currentLod().cut.members];

      const h2 = await open();
      try {
        const result = h2.nav.restoreFromFragment(fragment);
        expect(result.ok).toBe(true);
        await vi.waitFor(() => {
          if (h2.nav.inFlight()) return;
          if (h2.store.getState().nav!.zoom !== 1) throw new Error('not restored yet');
        });
        await h2.settle();
        const cameraB = h2.nav.displayedCamera();
        expect([...h2.nav.currentLod().cut.members]).toEqual(membersA);
        expect(cameraB.center.x).toBeCloseTo(cameraA.center.x, 6);
        expect(cameraB.center.y).toBeCloseTo(cameraA.center.y, 6);
        expect(cameraB.scale).toBeCloseTo(cameraA.scale, 6);
      } finally {
        await h2.destroy();
      }
    } finally {
      await h.destroy();
    }
  });
});

describe('store mutation mid-transition (P1 subscription forces replan)', () => {
  it('an op-based label delta lands as a mutation replan from the interpolated frame', async () => {
    const h = await open();
    try {
      h.nav.wheelZoom(60, CENTER);
      await waitForFlight(h.nav);
      h.clock.advance(80);
      h.nav.tick(); // genuinely mid-transition

      const node = h.nav.currentLod().cut.members[0]!;
      const applied = h.session.mutateNodeLabel(node, 'Mutated Mid Flight');
      expect(applied).toBe(true);

      await vi.waitFor(() => {
        const records = h.nav.telemetry();
        if (records.at(-1)?.trigger !== 'mutation') throw new Error('replan pending');
      });
      const records = h.nav.telemetry();
      expect(records[0]!.superseded).toBe(true);
      expect(records.at(-1)!.replannedFromFlight).toBe(true);

      await h.settle();
      // The new label is searchable through the rebuilt P1 token index.
      expect(h.nav.search('mutated').some((hit) => hit.node === node)).toBe(true);
    } finally {
      await h.destroy();
    }
  });
});
