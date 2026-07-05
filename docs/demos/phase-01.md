# Phase 1 demo — scripted deltas, streaming change events, undo as data

Roadmap §3 demo for Phase 1: *"CLI applies scripted deltas; watch mode
streams change events."* Plus the DoD requirement: *undo/redo demonstrably
works via `invertDelta` in a CLI session.* Everything below was executed on
2026-07-05 against commit state at phase close; all commands run from the
repo root after `pnpm build`.

## 1. Apply a scripted 20-op delta

```
$ pnpm meridian mutate fixtures/valid/deep-nest.meridian.json \
    --script fixtures/scripts/session.json
OK fixtures/valid/deep-nest.meridian.json
  v0 → v1 · demo-session · 20 ops (edge:add 4, edge:remove 1, graph:add 2,
    graph:meta 1, node:add 5, node:attr 5, node:detail 1, node:remove 1)
    · touched 7 graphs, 11 nodes
    [0] graph:add g-vendor "Vendor"
    …
    [19] node:attr g-project n-vendor demo:pinned (unset) → true
  now: graphs 8 · nodes 15 · edges 8 · roots 1 · max depth 5
```

The session exercises the whole op vocabulary v1 except `graph:remove`
(covered by the watch teardown script below): graph creation, node/edge
add/remove, attribute set, metadata change, and a containment claim
(`node:detail`) that turns a fresh root graph into `n-run`'s detail.

Rejections are atomic and typed — nothing partial ever lands:

```
$ pnpm meridian mutate fixtures/valid/deep-nest.meridian.json \
    --script fixtures/scripts/bad-node.json
REJECTED fixtures/scripts/bad-node.json
  errors (1):
    [unknown-node] ops[1] node:attr: node "n-ghost" is not in graph "g-app"
  nothing applied — deltas are atomic (fixtures/valid/deep-nest.meridian.json unchanged)

$ pnpm meridian mutate fixtures/valid/deep-nest.meridian.json \
    --script fixtures/scripts/stale.json
REJECTED fixtures/scripts/stale.json
  errors (1):
    [stale-delta] delta baseVersion v5@local does not match store version v0@local …
```

## 2. Undo/redo via inverted deltas (the whole point of ADR-0005)

```
$ pnpm meridian mutate fixtures/valid/deep-nest.meridian.json \
    --script fixtures/scripts/session.json \
    --out /tmp/after.json --emit-delta /tmp/d.json     # apply + record
$ pnpm meridian invert /tmp/d.json > /tmp/undo.json    # undo as data
$ pnpm meridian mutate /tmp/after.json --script /tmp/undo.json \
    --out /tmp/restored.json
OK /tmp/after.json
  v0 → v1 · demo-session · 20 ops (edge:add 1, edge:remove 4, graph:meta 1,
    graph:remove 2, node:add 1, node:attr 5, node:detail 1, node:remove 5) …
```

`/tmp/restored.json` is **byte-identical** to the original document
re-encoded with the CLI's producer stamp, and canonically identical to the
original space — asserted automatically in
`apps/cli/test/session.test.ts`, which also inverts the inverse (redo) and
byte-compares against `/tmp/after.json`.

Note the emitted delta is *completed*: every remove op carries its `prev`
payload, which is what makes the inverse computable from the file alone.
`meridian invert` emits the portable form without a version stamp (stamps
are per-store-session, ADR-0007); the ops' `prev` assertions are the
cross-session conflict guard — replaying the undo against a drifted
document fails with `op-conflict`, not silent corruption.

## 3. Watch mode streams change events

Deterministic replay (also golden-locked as `watch.deep-nest.apply.*`):

```
$ pnpm meridian watch fixtures/valid/deep-nest.meridian.json \
    --apply fixtures/scripts/watch-1.json,fixtures/scripts/watch-2-stale.json,fixtures/scripts/watch-3-teardown.json
watching fixtures/valid/deep-nest.meridian.json — v0 · 6 graphs · 11 nodes · 5 edges
v0 → v1 · watch-demo-1 · 2 ops (graph:meta 1, node:attr 1) · touched 1 graph, 1 node
    [0] node:attr g-lib n-util demo:loc 320 → 321
    [1] graph:meta g-lib "Library" → "Library (hot)"
REJECTED fixtures/scripts/watch-2-stale.json
  errors (1):
    [stale-delta] delta baseVersion v0@local does not match store version v1@local …
v1 → v2 · watch-demo-3 · 5 ops (edge:remove 1, graph:remove 1, node:detail 1, node:remove 2) · touched 2 graphs, 3 nodes
    [0] node:detail g-parse n-tokenize g-tokenize → (none)
    …
    [4] graph:remove g-tokenize
done: v2 · 2 applied, 1 rejected
```

Live mode (manual, `fs.watch`): edits saved to the file arrive as
semantic diff-deltas (`diffSpaces` → the one write path), and a touch with
no semantic change says so:

```
$ pnpm meridian watch /tmp/live.json      # then edit the file in an editor
watching /tmp/live.json — v0 · 6 graphs · 11 nodes · 5 edges
v0 → v1 · watch · 2 ops (graph:meta 1, node:attr 1) · touched 1 graph, 1 node
    [0] graph:meta g-lib "Library" → "Library LIVE-EDIT"
    [1] node:attr g-lib n-util demo:loc 320 → 999
/tmp/live.json: changed — no semantic difference
```

Events are delivered by the store's subscription machinery (ADR-0008):
batched one `ChangeSet` per committed transaction, asynchronously, in
commit order — the CLI printer is an ordinary listener.
