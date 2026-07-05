/** Thrown by constructors and derivation utilities on immediate misuse. */
export class MeridianError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MeridianError';
  }
}
