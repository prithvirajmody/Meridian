/**
 * Environment-neutral code-mapper contract. Implementations live in separate
 * modules so importing the production worker mapper cannot pull the
 * in-process tree-sitter runtime into an application main bundle.
 */
import type { RawBody } from './detail/types.js';
import type { CodeLanguage } from './languages.js';
import type { RawModule } from './map/raw.js';

/** A request to map one file. */
export interface MapModuleRequest {
  readonly language: CodeLanguage;
  /** Repository-relative POSIX path — the ADR-0028 `source` coordinate. */
  readonly source: string;
  /** Display label (basename). */
  readonly label: string;
  readonly text: string;
}

/** A request to materialize one function/method body (7F, ADR-0027): the file
 * text plus the declaration's byte span (the cold node's provenance span). */
export interface ResolveBodyRequest {
  readonly language: CodeLanguage;
  /** Repository-relative POSIX path — the ADR-0028 `source` coordinate. */
  readonly source: string;
  readonly text: string;
  /** `[startIndex, endIndex]` byte span of the function/method declaration. */
  readonly declSpan: readonly [number, number];
}

export interface CodeMapper {
  mapModule(req: MapModuleRequest, opts?: { readonly signal?: AbortSignal }): Promise<RawModule>;
  /** Parse `req.text` and build the {@link RawBody} of the declaration at
   * `req.declSpan`; `undefined` if no resolvable body is found (7F). Honors an
   * optional cancellation signal (ADR-0027 abandoned drill-in). */
  resolveBody(req: ResolveBodyRequest, opts?: { readonly signal?: AbortSignal }): Promise<RawBody | undefined>;
  dispose(): Promise<void>;
}
