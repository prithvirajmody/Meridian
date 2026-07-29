/**
 * Located ingest failures for organization documents. An org bundle is
 * external, untrusted data: malformed JSON, binary/NUL text, a wrong or
 * missing `schema_version`, or a structurally impossible document must fail
 * with a message that names *where* it went wrong — the source URI and a
 * JSON-ish locator — so a failed ingest is diagnosable, never a bare throw.
 * Crash containment (§7.4) is the conformance kit's job; this type just makes
 * the rejection honest and locatable.
 */
export interface OrgErrorLocation {
  /** The source descriptor URI the failure belongs to. */
  readonly uri: string;
  /** A JSON-ish path into the document, e.g. `workflow[2].next`. */
  readonly at?: string;
}

export class OrgParseError extends Error {
  override readonly name = 'OrgParseError';
  readonly uri: string;
  readonly at?: string;

  constructor(message: string, loc: OrgErrorLocation) {
    super(`${loc.uri}: ${message}${loc.at !== undefined ? ` (at ${loc.at})` : ''}`);
    this.uri = loc.uri;
    if (loc.at !== undefined) this.at = loc.at;
  }
}
