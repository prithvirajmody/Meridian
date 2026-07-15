# Writing a Meridian domain parser — plugin author guide (v1)

*Status: v1, published with the `plugin-api@1.0` freeze (Phase 9E,
ADR-0033). Grown from the Phase 2 toy-adapter exercise — a TODO-list parser
written against `@meridian/plugin-api` alone, which lives on as executable
documentation in `packages/conformance-kit/test/toy-todo.test.ts`; read it
side-by-side with this guide. Four first-party domains (markdown, code,
conversation, argument) were built against the contract before it froze.*

## What 1.0 promises you

The exported surface of `@meridian/plugin-api` is **frozen**: it is pinned by
a committed api-extractor report checked in CI, and it evolves
**additively only** until a deliberate 2.0 — new exports, new capability
kinds, new *optional* fields; nothing you compile against today will be
removed, renamed, narrowed, or re-semanticized in any 1.x (ADR-0033).
Declare `apiVersion: '^1.0.0'` in your manifest; the host refuses
incompatible manifests at registration with a typed error, never a crash.

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
   (`'^1.0.0'`; exact or caret only — ADR-0010), one capability
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
- Delta emission (`emitDelta`) is deliberately loosely typed in 1.0: the op
  vocabulary belongs to graph-store, and the gate validates every delta you
  stream. Emit documents unless you know why you need deltas
  (chafe report §2.2 records the rationale and the additive 1.x path).

## Beyond the skeleton (capabilities that shipped since the draft)

- **`detail-resolver`** (7F, ADR-0027): materialize deep detail lazily on
  drill-in — `canResolve(node)` + `resolve(node, sink)` emitting ordinary
  deltas. The code adapter's CFG/AST resolver is the reference.
- **`IncrementalAdapter`** (7G, ADR-0028): watch mode — `update(change,
  sink)` turns one `SourceChange` into a *minimal* delta (whitespace-only
  edit ⇒ empty delta; the incremental conformance suite enforces this).
- **AI-native domains** (Phase 9, ADR-0034): your parser stays the
  deterministic, AI-free skeleton — that is the whole contract. AI
  enrichment lives *outside* your package in the application composition
  root, reads your accepted skeleton, and enters the graph as
  provenance-tagged proposals. You never call AI, never see a store, and
  never need to: declare your enrichment vocabulary (node/edge kinds the
  enrichment pass may produce) in your manifest so enriched graphs validate,
  and keep your skeleton byte-deterministic. The conversation and argument
  adapters are the reference implementations.
- **Intent-driven adapters:** if your domain is a *reading* of a source
  rather than a detectable format (the argument adapter over prose), sniff
  with a deliberate under-bid — claim genuine input at a score below every
  format adapter's floor (0.1 < markdown's 0.15) so you satisfy the
  claim-your-corpus law without winning arbitrations you have no evidence
  for. Users select you explicitly (`--adapter <domain>`).

## What you may not do

No imports of any Meridian package other than `@meridian/plugin-api`
(dependency-cruiser will fail CI). No node builtins in adapter source —
parsers run in browsers and workers too. No geometry, no domain enums in
core namespaces (`core:*` is the platform's), no mutation path other than
what you emit through the sink.
