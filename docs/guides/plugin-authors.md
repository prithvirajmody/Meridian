# Writing a Meridian domain parser — plugin author guide (draft 1)

*Status: first draft, produced from the Phase 2 toy-adapter exercise
(ROADMAP Phase 2 §12, manual exploratory). The exercise — a TODO-list parser
written against `@meridian/plugin-api` alone — lives on as executable
documentation in `packages/conformance-kit/test/toy-todo.test.ts`; read it
side-by-side with this guide.*

## The contract in one paragraph

A plugin is one exported value: `{ manifest, activate }`. Importing your
module must do nothing (no module-scope side effects — ADR-0009).
`activate(ctx)` returns your capability implementations; for a domain parser
that is `{ parsers: [{ domain, sniff, ingest }] }`. `sniff(src)` returns a
confidence in [0, 1] and must be pure. `ingest(src, sink)` is the **skeleton
pass**: deterministic, AI-free, offline — same source, byte-identical output,
every time. You never see a store, the filesystem, or the network: the source
arrives as text/bytes in a `SourceDescriptor`, your output leaves through
`sink.emitDocument` (or streamed `emitDelta`s), and everything you emit is
validated at the IR gate before it can touch anything.

## Step by step (as the toy exercise went)

1. **Declare the manifest.** Name, your semver, an `apiVersion` range
   (`'^0.1.0'`; exact or caret only — ADR-0010), one capability
   `{ kind: 'domain-parser', id: '<your-domain>' }`, and — this part is law,
   not decoration — your **vocabulary**: every node/edge `kind` and every
   attr key your output uses, with a type per attr key (U8). An attr key you
   forgot to declare makes the gate reject your own output.
2. **Derive IDs from coordinates, never invent them.** `ctx.ids.nodeId({
   domain, source: src.uri, path: [...] })` — pick path segments that are
   stable under re-ingest (slugs, not array indices, wherever the source
   gives you something stable). This is what makes re-ingesting an unchanged
   file produce identical IDs (U4), which is what makes incremental updates
   and diffing possible later.
3. **Provenance on every element** — graph meta, node, edge: `origin:
   'source'` plus `uri` and a byte `span` when you have one. A skeleton pass
   must never emit `origin: 'ai'` (the conformance kit fails it).
4. **Recursion is a reference.** A node that *contains* structure gets
   `detail: { graph: <derived graph id> }` and you emit that graph as a
   sibling in the same document — the space is flat (ADR-0001). Only give a
   node a detail graph if it has children.
5. **Fail loudly, don't emit garbage.** Throw on input you can't handle
   (binary bytes, structurally impossible source). The host discards
   everything you emitted before the throw (atomic rollback) and stays
   healthy; your error message is what the user reads.
6. **Run the conformance kit before anything else.**

   ```ts
   import { describeParserConformance, loadCorpusDir } from '@meridian/conformance-kit';
   import { myPlugin } from '../src/index.js';

   describeParserConformance({
     plugin: myPlugin,
     corpus: loadCorpusDir(myCorpusDir, { mediaTypes: { ext: 'media/type' } }),
   });
   ```

   Put sources that must fail under `reject/` in your corpus directory. The
   kit checks manifest/exports coherence, sniff behavior, gate validity,
   determinism, and crash containment — the same law every first-party
   adapter passes.

## Friction found in the exercise → contract fixes already applied

- You could not type your emissions with plugin-api alone → the wire types
  (`GraphDocument`, `SemanticCoords`, `AttrValueType`) are now re-exported
  from `@meridian/plugin-api`.
- The corpus loader knew file extensions it had no business knowing → media
  types are now caller-supplied.
- Delta emission (`emitDelta`) is deliberately loosely typed in 0.1: the op
  vocabulary belongs to graph-store and streaming parsers arrive in Phase 7,
  a declared contract checkpoint. Emit documents unless you know why you
  need deltas.

## What you may not do

No imports of any Meridian package other than `@meridian/plugin-api`
(dependency-cruiser will fail CI). No node builtins in adapter source —
parsers run in browsers and workers too. No geometry, no domain enums in
core namespaces (`core:*` is the platform's), no mutation path other than
what you emit through the sink.
