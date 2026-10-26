import { describe, expect, it } from 'vitest';
import { dateTime, formatBytes, relativeTime } from '../src/format';
import { isNewer } from '../src/update-check';

describe('dateTime', () => {
  const now = new Date('2026-10-26T12:00:00.000Z');

  it('accepts offsets from now', () => {
    expect(dateTime('+30m', now)).toBe('2026-10-26T12:30:00.000Z');
    expect(dateTime('+2h', now)).toBe('2026-10-26T14:00:00.000Z');
    expect(dateTime('+1d', now)).toBe('2026-10-27T12:00:00.000Z');
    expect(dateTime('+1w', now)).toBe('2026-11-02T12:00:00.000Z');
  });

  it('accepts ISO 8601 with an offset', () => {
    expect(dateTime('2026-11-01T09:00Z')).toBe('2026-11-01T09:00:00.000Z');
    expect(dateTime('2026-11-01T09:00+02:00')).toBe('2026-11-01T07:00:00.000Z');
  });

  it('rejects a bare date, which would silently mean midnight UTC', () => {
    expect(() => dateTime('2026-11-01')).toThrow(/date and time/);
  });

  it('rejects nonsense', () => {
    expect(() => dateTime('tomorrow 10:00')).toThrow();
    expect(() => dateTime('+2y')).toThrow();
  });
});

describe('formatting', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('formats relative times', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(relativeTime(new Date('2026-10-26T14:00:00Z'), now)).toBe('in 2h');
    expect(relativeTime(new Date('2026-10-23T12:00:00Z'), now)).toBe('3d ago');
    expect(relativeTime(new Date('2026-10-26T12:00:20Z'), now)).toBe('just now');
  });
});

describe('isNewer', () => {
  it('compares release versions', () => {
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });

  it('never offers a pre-release', () => {
    expect(isNewer('2.0.0-beta.1', '1.0.0')).toBe(false);
  });
});
