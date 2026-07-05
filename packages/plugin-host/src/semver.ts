/**
 * The deliberately narrow semver-range check of ADR-0010: manifests may
 * declare an exact version ("0.1.0") or a caret range ("^0.1.0"). Nothing
 * else — a dependency-free 30 lines instead of a range grammar nobody needs
 * before the Phase 12 registry.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(v: string): [number, number, number] | undefined {
  const m = VERSION.exec(v);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Is `range` well-formed (exact or caret)? */
export function isValidRange(range: string): boolean {
  return parse(range.startsWith('^') ? range.slice(1) : range) !== undefined;
}

/**
 * Does semver `version` satisfy `range`? Caret follows the npm convention,
 * including the 0.x rules: `^0.2.1` accepts `>=0.2.1 <0.3.0`; `^0.0.3`
 * accepts only `0.0.3`.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  if (!range.startsWith('^')) {
    const r = parse(range);
    return r !== undefined && v[0] === r[0] && v[1] === r[1] && v[2] === r[2];
  }
  const r = parse(range.slice(1));
  if (!r) return false;
  const [vMaj, vMin, vPat] = v;
  const [rMaj, rMin, rPat] = r;
  if (vMaj !== rMaj) return false;
  if (rMaj > 0) return vMin > rMin || (vMin === rMin && vPat >= rPat);
  if (rMin > 0) return vMin === rMin && vPat >= rPat;
  return vMin === 0 && vPat === rPat;
}
