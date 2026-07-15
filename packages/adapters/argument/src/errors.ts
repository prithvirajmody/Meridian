/** Located parse failure — external data fails honestly, never silently
 * (ADR-0009); the location names what the message alone cannot. */
export interface ArgumentErrorLocation {
  /** Source URI the failing text came from. */
  readonly uri?: string;
  /** Where in the source the problem sits (e.g. `paragraph 3`). */
  readonly at?: string;
}

export class ArgumentParseError extends Error {
  readonly location: ArgumentErrorLocation;

  constructor(message: string, location: ArgumentErrorLocation = {}) {
    const suffix = [location.uri, location.at].filter((p) => p !== undefined).join(' — ');
    super(suffix.length > 0 ? `${message} (${suffix})` : message);
    this.name = 'ArgumentParseError';
    this.location = location;
  }
}
