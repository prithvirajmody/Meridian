/**
 * Keyboard navigation as a **pure command-mapping model** (ADR-0025 verb →
 * trigger table). This package has no DOM (§20): it maps an abstract key token
 * to a navigation *verb*; Studio (6D) owns the real `keydown` listener,
 * translates `KeyboardEvent.key` to a token, and dispatches the verb onto the
 * `NavigationController`. Pure and deterministic — a lookup table, no state.
 *
 * The table (ADR-0025):
 *   `+` / `=`        → continuous zoom-in   (a `zoomBy` step)
 *   `-` / `_`        → continuous zoom-out
 *   `Enter`          → drill-in on the selection
 *   `Escape`         → drill-out
 *   `Backspace`      → drill-out
 *   ` ` (Space)      → expand/collapse-in-place on the selection (toggle)
 * Anything else maps to `null` (ADR-0025: "anything not listed does nothing").
 */

/** A navigation verb a key resolves to (the controller's method surface). */
export type NavVerb = 'zoom-in' | 'zoom-out' | 'drill-in' | 'drill-out' | 'toggle-expand';

/** A resolved keyboard command: the verb plus whether it needs the current
 * selection (`drill-in`/`toggle-expand` act on the selected node). */
export interface NavCommand {
  readonly verb: NavVerb;
  /** True when the verb operates on the current selection (Studio supplies the
   * selected `NodeId` at dispatch time). */
  readonly needsSelection: boolean;
}

const TABLE: Readonly<Record<string, NavCommand>> = {
  '+': { verb: 'zoom-in', needsSelection: false },
  '=': { verb: 'zoom-in', needsSelection: false },
  '-': { verb: 'zoom-out', needsSelection: false },
  _: { verb: 'zoom-out', needsSelection: false },
  Enter: { verb: 'drill-in', needsSelection: true },
  Escape: { verb: 'drill-out', needsSelection: false },
  Esc: { verb: 'drill-out', needsSelection: false },
  Backspace: { verb: 'drill-out', needsSelection: false },
  ' ': { verb: 'toggle-expand', needsSelection: true },
  Spacebar: { verb: 'toggle-expand', needsSelection: true },
};

/**
 * Map an abstract key token (a `KeyboardEvent.key` value) to a
 * {@link NavCommand}, or `null` when the key is not a navigation trigger
 * (ADR-0025). Pure; the table is the contract the 6C test asserts row by row.
 */
export function keyToNavCommand(key: string): NavCommand | null {
  return TABLE[key] ?? null;
}

/** The whole trigger table as data (for the 6C table test and the 6E panel). */
export function navKeyBindings(): ReadonlyMap<string, NavCommand> {
  return new Map(Object.entries(TABLE));
}
