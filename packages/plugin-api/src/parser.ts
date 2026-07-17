/**
 * The `domain-parser` capability (ARCHITECTURE.md §7): source in, IR out,
 * nothing else. The skeleton pass must be deterministic, AI-free, and
 * reproducible byte-for-byte (P6, §6.3); everything emitted passes the IR
 * gate before it can touch a store.
 */
import type { GraphDocument } from '@meridian/graph-core';
import type { Progress, SourceChange, SourceDescriptor } from './source.js';

/**
 * Wire form of an op-based delta (ADR-0005). The op vocabulary belongs to
 * graph-store and is deliberately not re-declared here — deltas are decoded
 * and gated downstream exactly like documents. Streaming is contract v1 so
 * P7/P11 don't need a second contract; Phase 2 parsers emit documents.
 */
export interface DeltaWire {
  readonly ops: readonly unknown[];
  readonly origin?: unknown;
  readonly baseVersion?: unknown;
}

/**
 * Where a parser's output goes. A host may provide buffered atomic ingest or
 * Phase-11 streaming ingest into caller-owned private staging. Streaming
 * hosts expose {@link drain}; parsers that can emit large runs should await it
 * at bounded batch boundaries. The optional member keeps every existing
 * parser source-compatible, and buffered hosts may omit it.
 */
export interface IngestSink {
  emitDocument(doc: GraphDocument): void;
  emitDelta(delta: DeltaWire): void;
  progress(p: Progress): void;
  /** Optional lifetime for this ingest. Long-running parsers should stop at
   * bounded work boundaries and pass it through to cancellable workers. */
  readonly signal?: AbortSignal;
  /** Await all emissions accepted before this call (stream backpressure). */
  drain?(): Promise<void>;
}

export interface DomainParser {
  /** The domain this parser produces, e.g. a graph's `meta.domain`. Must
   * equal its manifest `domain-parser` capability `id`. */
  readonly domain: string;
  /** Confidence in [0, 1] that this parser can handle `src`. Pure. */
  sniff(src: SourceDescriptor): number;
  /** The skeleton pass: deterministic, AI-free, offline (§7.2.3). */
  ingest(src: SourceDescriptor, sink: IngestSink): Promise<void>;
}

/**
 * Watch-mode contract (ROADMAP Phase 7 §5, §7): a stateful adapter that, given
 * one {@link SourceChange}, emits a **minimal** `GraphDelta` through the ordinary
 * {@link IngestSink} (ADR-0005 — one write path) rather than re-ingesting the
 * whole source. It holds the prior parse across calls, so `update` is the
 * incremental analogue of a `DomainParser.ingest`: file change in, op delta out.
 *
 * Type-only surface (like the other post-P2 contract shapes): a plugin does not
 * *declare* this as a capability — a host obtains an incremental session from an
 * adapter it already knows can parse the domain. The incremental *conformance*
 * suite in `conformance-kit` is written against exactly this shape, so any
 * adapter's session is exercised by the same reusable harness.
 */
export interface IncrementalAdapter {
  update(change: SourceChange, sink: IngestSink): Promise<void>;
}

/** Element provenance counts across everything one ingest emitted (U7). */
export interface ProvenanceTally {
  readonly source: number;
  readonly derived: number;
  readonly ai: number;
}

/** The host's account of one ingest run (roadmap Phase 2 §7). */
export interface IngestReport {
  readonly plugin: string;
  readonly domain: string;
  readonly source: string;
  readonly documents: number;
  readonly deltas: number;
  readonly graphs: number;
  readonly nodes: number;
  readonly edges: number;
  readonly provenance: ProvenanceTally;
  readonly warnings: readonly string[];
  readonly elapsedMs: number;
}
