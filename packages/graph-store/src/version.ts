/**
 * Version stamps (ADR-0007): a monotonic per-store counter plus a reserved
 * site component. v1 is single-writer — `site` is always 'local'; Phase 12
 * extends the semantics to Lamport (counter, site) pairs without a shape
 * change. Stamps identify states within one store session (durability: P11).
 */

export interface VersionStamp {
  readonly counter: number;
  readonly site: string;
}

export const LOCAL_SITE = 'local';

export function initialVersion(site: string = LOCAL_SITE): VersionStamp {
  return { counter: 0, site };
}

/** The stamp after one committed transaction. Pure — invertDelta relies on it. */
export function successorVersion(v: VersionStamp): VersionStamp {
  return { counter: v.counter + 1, site: v.site };
}

/** Total order (U5): counter first, site as the reserved tie-break. */
export function compareVersions(a: VersionStamp, b: VersionStamp): number {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.site < b.site ? -1 : a.site > b.site ? 1 : 0;
}

export function versionsEqual(a: VersionStamp, b: VersionStamp): boolean {
  return a.counter === b.counter && a.site === b.site;
}

/** Compact human form: "v3" for the local site, "v3@site" otherwise. */
export function formatVersion(v: VersionStamp): string {
  return v.site === LOCAL_SITE ? `v${v.counter}` : `v${v.counter}@${v.site}`;
}
