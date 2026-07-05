/** Version stamps (ADR-0007). */
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  formatVersion,
  initialVersion,
  LOCAL_SITE,
  successorVersion,
  versionsEqual,
} from '../src/index.js';

describe('version stamps', () => {
  it('starts at 0 on the local site and advances by one', () => {
    const v0 = initialVersion();
    expect(v0).toEqual({ counter: 0, site: LOCAL_SITE });
    expect(successorVersion(v0)).toEqual({ counter: 1, site: LOCAL_SITE });
    expect(successorVersion(successorVersion(v0)).counter).toBe(2);
  });

  it('orders totally: counter first, site as reserved tie-break', () => {
    expect(compareVersions({ counter: 1, site: 'local' }, { counter: 2, site: 'local' })).toBeLessThan(0);
    expect(compareVersions({ counter: 3, site: 'local' }, { counter: 2, site: 'local' })).toBeGreaterThan(0);
    expect(compareVersions({ counter: 2, site: 'a' }, { counter: 2, site: 'b' })).toBeLessThan(0);
    expect(compareVersions({ counter: 2, site: 'x' }, { counter: 2, site: 'x' })).toBe(0);
  });

  it('equality is both fields', () => {
    expect(versionsEqual({ counter: 1, site: 'local' }, { counter: 1, site: 'local' })).toBe(true);
    expect(versionsEqual({ counter: 1, site: 'local' }, { counter: 1, site: 'remote' })).toBe(false);
  });

  it('formats compactly, eliding the local site', () => {
    expect(formatVersion({ counter: 4, site: 'local' })).toBe('v4');
    expect(formatVersion({ counter: 4, site: 's9' })).toBe('v4@s9');
  });
});
