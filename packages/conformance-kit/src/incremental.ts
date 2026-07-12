/**
 * Incremental adapter conformance (ROADMAP Phase 7 §7, §11): the executable law
 * for {@link IncrementalAdapter}. Like {@link ./index.js describeParserConformance}
 * it is written against the *contract*, not any adapter, and imports only
 * plugin-api + graph-core (§20) — so it drives an incremental session exactly as
 * a host would (a buffered sink) and never reaches for a store engine.
 *
 * What it pins for every adapter that runs it:
 * - **minimal deltas** — each scripted edit's emitted delta has the expected op
 *   count (0 for a whitespace-only edit, the flagship; a small asserted count for
 *   a single-declaration edit);
 * - **gate-validity** — after every edit the adapter's current document decodes
 *   clean against its own declared vocabulary (U8);
 * - **convergence (I6)** — the incrementally-maintained document equals a
 *   from-scratch ingest of the same final files, byte-for-byte; watch mode never
 *   drifts from cold ingest;
 * - **determinism** — replaying the whole edit script yields byte-identical
 *   deltas.
 *
 * The store-application of these deltas (that "minimal" is also "valid") is
 * proven in each adapter's own suite, where graph-store is available; the kit
 * stays store-free by design.
 */
import { decode, encodeCanonical, type VocabularyRegistry } from '@meridian/graph-core';
import type {
  DeltaWire,
  GraphDocument,
  IncrementalAdapter,
  IngestSink,
  PluginManifest,
  SourceChange,
} from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import { vocabularyOf } from './vocabulary.js';

/** One file in an incremental scenario's evolving project. */
export interface ScenarioFile {
  readonly path: string;
  readonly text: string;
}

/** One scripted edit and the shape its delta must have. */
export interface IncrementalEdit {
  /** Human label for the assertion output. */
  readonly name: string;
  readonly change: SourceChange;
  /** Assert the emitted delta is empty (0 ops) — the whitespace/no-op case. */
  readonly expectEmpty?: boolean;
  /** Assert an exact op count (the "minimal delta" contract for this edit). */
  readonly expectOps?: number;
  /** Optional finer assertion over the raw wire ops. */
  readonly expectOpsMatch?: (ops: readonly Record<string, unknown>[]) => void;
}

export interface IncrementalScenario {
  readonly name: string;
  readonly initial: readonly ScenarioFile[];
  readonly edits: readonly IncrementalEdit[];
}

/** A fresh incremental session plus a window onto its current document. */
export interface IncrementalSession {
  readonly adapter: IncrementalAdapter;
  /** The adapter's current eager document (the store seed / baseline). */
  document(): GraphDocument;
}

export interface IncrementalConformanceOptions {
  /** The adapter's manifest — its declared vocabulary gates every document. */
  readonly manifest: PluginManifest;
  /** Build a fresh incremental session over `initial`. */
  readonly setup: (initial: readonly ScenarioFile[]) => Promise<IncrementalSession>;
  /** A from-scratch (cold) ingest of `files` to the same document shape — the
   * convergence oracle (watch result must equal cold-ingest result). */
  readonly freshDocument: (files: readonly ScenarioFile[]) => Promise<GraphDocument>;
  readonly scenarios: readonly IncrementalScenario[];
}

/** Fold a `SourceChange` into a running file list (add / modify / delete). */
function applyChange(files: ScenarioFile[], change: SourceChange): ScenarioFile[] {
  const rest = files.filter((f) => f.path !== change.path);
  if (change.newText === undefined) return rest; // delete
  return [...rest, { path: change.path, text: change.newText }];
}

function collect(): { sink: IngestSink; deltas: DeltaWire[] } {
  const deltas: DeltaWire[] = [];
  return {
    deltas,
    sink: { emitDocument: () => undefined, emitDelta: (d) => deltas.push(d), progress: () => undefined },
  };
}

/** Run a scenario, returning the flat op-JSON of every edit (for a determinism
 * replay to compare against). */
async function runScenario(
  opts: IncrementalConformanceOptions,
  scenario: IncrementalScenario,
  vocabulary: VocabularyRegistry,
  assert: boolean,
): Promise<string[]> {
  const session = await opts.setup(scenario.initial);
  let files = [...scenario.initial];
  const opJson: string[] = [];

  for (const edit of scenario.edits) {
    const { sink, deltas } = collect();
    await session.adapter.update(edit.change, sink);
    files = applyChange(files, edit.change);

    if (assert) {
      expect(deltas, `${edit.name}: update must emit exactly one delta`).toHaveLength(1);
    }
    const ops = (deltas[0]?.ops ?? []) as Record<string, unknown>[];
    opJson.push(JSON.stringify(ops));

    if (!assert) continue;

    if (edit.expectEmpty) {
      expect(ops, `${edit.name}: expected an EMPTY delta`).toHaveLength(0);
    }
    if (edit.expectOps !== undefined) {
      expect(ops.length, `${edit.name}: expected ${edit.expectOps} ops`).toBe(edit.expectOps);
    }
    edit.expectOpsMatch?.(ops);

    // Gate-validity: the current document decodes clean against the vocabulary.
    const gate = decode(session.document(), { vocabulary });
    expect(gate.ok ? [] : gate.errors, `${edit.name}: document must gate-decode`).toEqual([]);

    // Convergence (I6): incremental == from-scratch, byte-for-byte.
    const fresh = await opts.freshDocument(files);
    const a = decode(session.document());
    const b = decode(fresh);
    expect(a.ok && b.ok, `${edit.name}: both documents must decode`).toBe(true);
    if (a.ok && b.ok) {
      expect(
        encodeCanonical(a.space),
        `${edit.name}: incremental document must equal a from-scratch ingest`,
      ).toBe(encodeCanonical(b.space));
    }
  }
  return opJson;
}

export function describeIncrementalConformance(opts: IncrementalConformanceOptions): void {
  const vocabulary = vocabularyOf(opts.manifest);

  describe(`incremental conformance: ${opts.manifest.name}`, () => {
    for (const scenario of opts.scenarios) {
      describe(scenario.name, () => {
        it('emits minimal, gate-valid deltas and converges to a from-scratch ingest', async () => {
          await runScenario(opts, scenario, vocabulary, true);
        });

        it('is deterministic — replaying the edit script is byte-identical', async () => {
          const first = await runScenario(opts, scenario, vocabulary, false);
          const second = await runScenario(opts, scenario, vocabulary, false);
          expect(second).toEqual(first);
        });
      });
    }
  });
}
