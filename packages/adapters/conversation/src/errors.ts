/**
 * Located, format-specific ingest failures. A conversation export is external,
 * untrusted data (ADR-0009): malformed JSON, an irrecoverable schema mismatch,
 * binary/NUL text, or a shape no per-format parser recognizes must fail with a
 * message that names *where* it went wrong — the source URI, the detected (or
 * absent) format, and a JSON-ish locator — so a failed ingest is diagnosable,
 * never a bare throw. Crash containment (§7.4) is the conformance kit's job;
 * this type just makes the rejection honest and locatable.
 */
export interface ConversationErrorLocation {
  /** The source descriptor URI the failure belongs to. */
  readonly uri: string;
  /** The recognized export format, when one was already selected. */
  readonly format?: 'claude' | 'chatgpt';
  /** A JSON-ish path into the export, e.g. `conversations[2].chat_messages[5]`. */
  readonly at?: string;
}

export class ConversationParseError extends Error {
  override readonly name = 'ConversationParseError';
  readonly uri: string;
  readonly format?: 'claude' | 'chatgpt';
  readonly at?: string;

  constructor(message: string, loc: ConversationErrorLocation) {
    const where = [
      loc.format !== undefined ? `format=${loc.format}` : undefined,
      loc.at !== undefined ? `at ${loc.at}` : undefined,
    ]
      .filter((s) => s !== undefined)
      .join(', ');
    super(`${loc.uri}: ${message}${where.length > 0 ? ` (${where})` : ''}`);
    this.uri = loc.uri;
    if (loc.format !== undefined) this.format = loc.format;
    if (loc.at !== undefined) this.at = loc.at;
  }
}
