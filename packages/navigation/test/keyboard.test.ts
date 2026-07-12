/**
 * Keyboard command mapping (ADR-0025 verb → trigger table) as a pure lookup —
 * asserted row by row. No DOM in the package (§20).
 */
import { describe, expect, it } from 'vitest';
import { keyToNavCommand, navKeyBindings, type NavVerb } from '../src/keyboard.js';

describe('keyToNavCommand (ADR-0025 trigger table)', () => {
  const rows: readonly [key: string, verb: NavVerb, needsSelection: boolean][] = [
    ['+', 'zoom-in', false],
    ['=', 'zoom-in', false],
    ['-', 'zoom-out', false],
    ['_', 'zoom-out', false],
    ['Enter', 'drill-in', true],
    ['Escape', 'drill-out', false],
    ['Esc', 'drill-out', false],
    ['Backspace', 'drill-out', false],
    [' ', 'toggle-expand', true],
    ['Spacebar', 'toggle-expand', true],
  ];

  it.each(rows)('maps %j → %s (needsSelection=%s)', (key, verb, needsSelection) => {
    expect(keyToNavCommand(key)).toEqual({ verb, needsSelection });
  });

  it('maps unlisted keys to null (anything not listed does nothing)', () => {
    for (const key of ['a', 'ArrowUp', 'Tab', 'F1', '1', 'Shift']) {
      expect(keyToNavCommand(key)).toBeNull();
    }
  });

  it('exposes the whole binding table as data', () => {
    const bindings = navKeyBindings();
    expect(bindings.get('Enter')).toEqual({ verb: 'drill-in', needsSelection: true });
    expect(bindings.size).toBe(rows.length);
  });
});
