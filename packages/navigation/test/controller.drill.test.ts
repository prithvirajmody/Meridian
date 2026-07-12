/**
 * Drill-in/out context stack (ADR-0025): located no-op on a node with no
 * detail, exact state restoration on drill-out (overrides included), derived
 * breadcrumbs, fly-to targeting (never drills), and the URL round-trip that
 * restores the exact current view.
 */
import { describe, expect, it } from 'vitest';
import type { ZoomPolicy } from '@meridian/abstraction';
import type { Point } from '@meridian/view-model';
import { asNodeId } from '@meridian/graph-core';
import { NavigationController } from '../src/controller.js';
import { buildSpace } from './helpers.js';

const SPACE = buildSpace([
  { id: 'A', children: [{ id: 'a1', children: [{ id: 'a1x' }, { id: 'a1y' }] }, { id: 'a2' }] },
]);
const POLICY: ZoomPolicy = { thresholds: [0.34, 0.67], hysteresis: 0.1 };
const VIEWPORT = { width: 100, height: 100 };
const ANCHOR: Point = { x: 50, y: 50 };

function newController() {
  return new NavigationController({ space: SPACE, policy: POLICY, viewport: VIEWPORT, initialZoom: 0 });
}

describe('drill-in / drill-out (ADR-0025)', () => {
  it('drills into a node with a detail graph, pushing a context', () => {
    const ctrl = newController();
    expect(ctrl.context().depth).toBe(1);
    expect(ctrl.context().cutMembers).toEqual([asNodeId('A')]);

    let cutEvents = 0;
    let ctxEvents = 0;
    ctrl.on('cutchange', () => cutEvents++);
    ctrl.on('context', () => ctxEvents++);

    ctrl.drillInto(asNodeId('A'));
    const ctx = ctrl.context();
    expect(ctx.depth).toBe(2);
    expect(ctx.focus).toEqual(asNodeId('A')); // focus = the drilled node
    expect(ctx.cutMembers).toEqual([asNodeId('a1'), asNodeId('a2')]); // detail chain, z = 0
    expect(cutEvents).toBe(1);
    expect(ctxEvents).toBe(1);
  });

  it('drill into a node with no detail is a located no-op (never throws)', () => {
    const ctrl = newController();
    ctrl.drillInto(asNodeId('A')); // now in A's detail context {a1, a2}
    expect(() => ctrl.drillInto(asNodeId('a2'))).not.toThrow(); // a2 is a leaf
    expect(ctrl.lastNotice()?.code).toBe('no-detail');
    expect(ctrl.context().depth).toBe(2); // unchanged
  });

  it('drill into a node outside the current context is a located no-op', () => {
    const ctrl = newController();
    ctrl.drillInto(asNodeId('a1')); // a1 not visible/in-context from the root cut? a1 ∈ root subtree
    // a1 IS in the root context (full subtree); drilling it is allowed. Now in a1's detail.
    expect(ctrl.context().depth).toBe(2);
    // 'B' does not exist at all → out of context.
    ctrl.drillInto(asNodeId('B'));
    expect(ctrl.lastNotice()?.code).toBe('unknown-node');
    expect(ctrl.context().depth).toBe(2);
  });

  it('drill-out at the root is a located no-op (no scope surprise)', () => {
    const ctrl = newController();
    ctrl.drillOut();
    expect(ctrl.lastNotice()?.code).toBe('at-root');
    expect(ctrl.context().depth).toBe(1);
  });

  it('drill-out restores the parent saved state exactly — overrides included', () => {
    const ctrl = newController();
    ctrl.expand(asNodeId('A')); // root override → cut {a1, a2}
    ctrl.zoomTo(0.2, ANCHOR); // move the parent camera/zoom
    const savedCamera = ctrl.camera();
    const savedZoom = ctrl.zoom();
    const savedCut = ctrl.context().cutMembers.join(' ');

    ctrl.drillInto(asNodeId('a1')); // descend
    expect(ctrl.context().depth).toBe(2);

    ctrl.drillOut();
    const restored = ctrl.context();
    expect(restored.depth).toBe(1);
    expect(restored.overrides.get(asNodeId('A'))).toBe('expand'); // override preserved
    expect(restored.cutMembers.join(' ')).toBe(savedCut);
    expect(ctrl.camera()).toEqual(savedCamera); // camera restored exactly
    expect(ctrl.zoom()).toBe(savedZoom);
  });

  it('derives breadcrumbs from containment + the stack (never stored)', () => {
    const ctrl = newController();
    ctrl.drillInto(asNodeId('A'));
    ctrl.drillInto(asNodeId('a1'));
    const crumbs = ctrl.context().breadcrumbs;
    expect(crumbs).toHaveLength(3);
    expect(crumbs[0]!.node).toBeUndefined(); // root has no drilled node
    expect(crumbs[1]!.node).toEqual(asNodeId('A'));
    expect(crumbs[1]!.label).toBe('A');
    expect(crumbs[2]!.node).toEqual(asNodeId('a1'));
  });
});

describe('fly-to (ADR-0025: sets focus, never drills)', () => {
  it('search → fly-to targets the node without changing the context stack', () => {
    const ctrl = newController();
    const hits = ctrl.search('a1x');
    expect(hits.map((h) => h.node)).toEqual([asNodeId('a1x')]);

    let ctxEvents = 0;
    ctrl.on('context', () => ctxEvents++);
    ctrl.flyTo(hits[0]!.node);

    expect(ctrl.context().focus).toEqual(asNodeId('a1x'));
    expect(ctrl.flyToTarget()).toEqual(asNodeId('a1x'));
    expect(ctrl.context().depth).toBe(1); // never drilled
    expect(ctxEvents).toBe(1);
  });

  it('scopes search to the current context', () => {
    const ctrl = newController();
    ctrl.drillInto(asNodeId('a1')); // context = a1's detail {a1x, a1y}
    expect(ctrl.search('a2')).toEqual([]); // a2 is outside this context
    expect(ctrl.search('a1x').map((h) => h.node)).toEqual([asNodeId('a1x')]);
  });
});

describe('URL round-trip restores the exact current view (ROADMAP §11)', () => {
  it('encode → decode → restore reproduces z, camera, focus, drill path, overrides', () => {
    const ctrl = newController();
    ctrl.drillInto(asNodeId('A'));
    ctrl.expand(asNodeId('a1')); // current-context override → exercised in `ov`
    ctrl.flyTo(asNodeId('a1x'));
    ctrl.zoomTo(0.6, ANCHOR);
    const original = ctrl.context();

    const encoded = ctrl.toUrl();
    expect(encoded.truncated).toBe(false);

    const restored = new NavigationController({
      space: SPACE,
      policy: POLICY,
      viewport: VIEWPORT,
      initialZoom: 0,
    });
    const result = restored.restoreFromFragment(encoded.fragment);
    expect(result.ok).toBe(true);
    expect(restored.context()).toEqual(original);
  });

  it('a wrong-space fragment restores with a located error, never throws', () => {
    const restored = newController();
    const result = restored.restoreFromFragment('#g=some-other-graph&z=0.5&cam=0,0,1');
    expect(result.ok).toBe(false);
    expect(restored.lastNotice()?.code).toBe('url');
    expect(restored.context().depth).toBe(1);
  });
});
