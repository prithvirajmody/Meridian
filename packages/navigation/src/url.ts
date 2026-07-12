/**
 * URL state codec (ADR-0025). The fragment serializes the complete navigation
 * state so any view is linkable and round-trips *exactly* (ROADMAP §11):
 *
 * ```
 * #g=<rootGraphId>&ctx=<nodeId,nodeId,…>&z=<0..1>&cam=<cx,cy,s>&focus=<nodeId>&ov=<id:p|e|c,…>
 * ```
 *
 * - `g`   — the root graph id (identity of the space the link belongs to).
 * - `ctx` — the drill path: the node ids drilled into, in order (graph ids are
 *   recoverable from the nodes' detail refs, so only nodes are stored).
 * - `z`   — the current zoom scalar.
 * - `cam` — the camera `center.x, center.y, scale`.
 * - `focus` — the current focus node (omitted when absent).
 * - `ov`  — the current override map, `id:p|e|c` (`p`in/`e`xpand/`c`ollapse),
 *   omitted when empty.
 *
 * `prevLevel`/hysteresis residue is deliberately **not** serialized — a restored
 * view resolves fresh (ADR-0012/0025). If the fragment would exceed
 * `URL_MAX = 2000`, `ov` is truncated (from the tail) with a diagnostic so the
 * link stays shareable and honest.
 *
 * Ids may contain `&`, `,`, `:`, `=`, so every id is percent-encoded
 * (`encodeURIComponent`); the delimiters stay literal. Decoding never throws:
 * a malformed fragment yields located `errors`. Numbers use `String`/`Number`,
 * which round-trip IEEE-754 doubles exactly, so `z`/`cam` restore bit-for-bit.
 *
 * *(Flagged for ADR-0025 fold-back: the ADR's grammar does not specify id
 * escaping; percent-encoding is the defensible reading and is required for
 * code-domain ids that contain the delimiters.)*
 */
import type { GraphId, NodeId } from '@meridian/view-model';
import type { OverrideKind } from '@meridian/abstraction';
import { URL_MAX } from './constants.js';

/** The parsed navigation state a URL fragment carries (ADR-0025). */
export interface NavUrlState {
  readonly g: GraphId;
  readonly ctx: readonly NodeId[];
  readonly z: number;
  readonly cam: { readonly cx: number; readonly cy: number; readonly s: number };
  readonly focus?: NodeId;
  readonly ov: readonly { readonly node: NodeId; readonly kind: OverrideKind }[];
}

/** The outcome of encoding, including any `URL_MAX` truncation (ADR-0025). */
export interface EncodedNavUrl {
  /** The fragment, `#`-prefixed. */
  readonly fragment: string;
  /** True when `ov` entries were dropped to fit `URL_MAX`. */
  readonly truncated: boolean;
  /** How many `ov` entries were dropped (0 unless truncated). */
  readonly droppedOverrides: number;
}

/** A located decode failure (ADR-0025: malformed fragments never throw). */
export type DecodedNavUrl =
  | { readonly ok: true; readonly state: NavUrlState }
  | { readonly ok: false; readonly errors: readonly string[] };

const KIND_CODE: Readonly<Record<OverrideKind, string>> = { pin: 'p', expand: 'e', collapse: 'c' };
const CODE_KIND: Readonly<Record<string, OverrideKind>> = { p: 'pin', e: 'expand', c: 'collapse' };

function enc(id: string): string {
  return encodeURIComponent(id);
}

function ovField(ov: NavUrlState['ov']): string {
  return ov.map((o) => `${enc(o.node)}:${KIND_CODE[o.kind]}`).join(',');
}

function assemble(state: NavUrlState, ov: NavUrlState['ov']): string {
  const parts = [`g=${enc(state.g)}`];
  if (state.ctx.length > 0) parts.push(`ctx=${state.ctx.map(enc).join(',')}`);
  parts.push(`z=${String(state.z)}`);
  parts.push(`cam=${String(state.cam.cx)},${String(state.cam.cy)},${String(state.cam.s)}`);
  if (state.focus !== undefined) parts.push(`focus=${enc(state.focus)}`);
  if (ov.length > 0) parts.push(`ov=${ovField(ov)}`);
  return `#${parts.join('&')}`;
}

/**
 * Encode navigation state into a `#`-prefixed fragment (ADR-0025). If the full
 * fragment exceeds `URL_MAX`, `ov` entries are dropped from the tail until it
 * fits (or `ov` is empty), and the drop is reported — `g/ctx/z/cam/focus` are
 * never dropped, since the cut depends on them.
 */
export function encodeNavUrl(state: NavUrlState, urlMax: number = URL_MAX): EncodedNavUrl {
  let ov = state.ov;
  let fragment = assemble(state, ov);
  let dropped = 0;
  while (fragment.length > urlMax && ov.length > 0) {
    ov = ov.slice(0, -1);
    dropped++;
    fragment = assemble(state, ov);
  }
  return { fragment, truncated: dropped > 0, droppedOverrides: dropped };
}

function parseNumber(raw: string | undefined, label: string, errors: string[]): number | undefined {
  if (raw === undefined) {
    errors.push(`${label}: missing`);
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    errors.push(`${label}: not a finite number (${raw})`);
    return undefined;
  }
  return n;
}

/**
 * Decode a fragment (with or without a leading `#`) into {@link NavUrlState}.
 * Never throws: unknown keys are ignored; missing/malformed required fields
 * (`g`, `z`, `cam`) or malformed `ov`/`ctx` entries produce a located
 * `errors` list. Percent-encoded ids are decoded.
 */
export function decodeNavUrl(fragment: string): DecodedNavUrl {
  const errors: string[] = [];
  const body = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const fields = new Map<string, string>();
  for (const part of body.split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    if (eq < 0) {
      errors.push(`field without '=': ${part}`);
      continue;
    }
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }

  const decodeId = (raw: string, label: string): string | undefined => {
    try {
      return decodeURIComponent(raw);
    } catch {
      errors.push(`${label}: malformed percent-encoding (${raw})`);
      return undefined;
    }
  };

  const gRaw = fields.get('g');
  const g = gRaw !== undefined ? decodeId(gRaw, 'g') : (errors.push('g: missing'), undefined);

  const ctx: NodeId[] = [];
  const ctxRaw = fields.get('ctx');
  if (ctxRaw !== undefined && ctxRaw.length > 0) {
    for (const raw of ctxRaw.split(',')) {
      const id = decodeId(raw, 'ctx');
      if (id !== undefined) ctx.push(id as NodeId);
    }
  }

  const z = parseNumber(fields.get('z'), 'z', errors);

  let cam: NavUrlState['cam'] | undefined;
  const camRaw = fields.get('cam');
  if (camRaw === undefined) {
    errors.push('cam: missing');
  } else {
    const nums = camRaw.split(',');
    if (nums.length !== 3) {
      errors.push(`cam: expected 3 comma-separated numbers, got ${nums.length}`);
    } else {
      const cx = parseNumber(nums[0], 'cam.cx', errors);
      const cy = parseNumber(nums[1], 'cam.cy', errors);
      const s = parseNumber(nums[2], 'cam.s', errors);
      if (cx !== undefined && cy !== undefined && s !== undefined) cam = { cx, cy, s };
    }
  }

  let focus: NodeId | undefined;
  const focusRaw = fields.get('focus');
  if (focusRaw !== undefined && focusRaw.length > 0) {
    const id = decodeId(focusRaw, 'focus');
    if (id !== undefined) focus = id as NodeId;
  }

  const ov: { node: NodeId; kind: OverrideKind }[] = [];
  const ovRaw = fields.get('ov');
  if (ovRaw !== undefined && ovRaw.length > 0) {
    for (const entry of ovRaw.split(',')) {
      const colon = entry.lastIndexOf(':');
      if (colon < 0) {
        errors.push(`ov: entry without ':' (${entry})`);
        continue;
      }
      const id = decodeId(entry.slice(0, colon), 'ov');
      const kind = CODE_KIND[entry.slice(colon + 1)];
      if (id === undefined) continue;
      if (kind === undefined) {
        errors.push(`ov: unknown override code in (${entry})`);
        continue;
      }
      ov.push({ node: id as NodeId, kind });
    }
  }

  if (errors.length > 0 || g === undefined || z === undefined || cam === undefined) {
    return { ok: false, errors: errors.length > 0 ? errors : ['incomplete fragment'] };
  }
  return { ok: true, state: { g: g as GraphId, ctx, z, cam, focus, ov } };
}
