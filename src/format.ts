import { InvalidArgumentError } from '@commander-js/extra-typings';

/** Commander parser for repeatable options: `--channel a --channel b`. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Commander parser for positive integers. */
export function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Must be a positive integer.');
  return n;
}

const RELATIVE = /^\+(\d+)(m|h|d|w)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/**
 * Commander parser for a point in time, returned as an ISO 8601 string.
 *
 * Accepts ISO 8601 (`2026-11-01T09:00:00Z`, `2026-11-01T09:00+02:00`, or without an
 * offset for local time) and offsets from now: `+30m`, `+2h`, `+1d`, `+1w`.
 */
export function dateTime(value: string, now: Date = new Date()): string {
  const relative = RELATIVE.exec(value.trim());
  if (relative) {
    const unit = relative[2] as keyof typeof UNIT_MS;
    return new Date(now.getTime() + Number(relative[1]) * UNIT_MS[unit]).toISOString();
  }
  // A bare date would be read as midnight UTC, which is rarely what anyone means.
  if (!/\d{2}:\d{2}/.test(value)) {
    throw new InvalidArgumentError(
      'Expected a date and time, e.g. 2026-11-01T09:00 (local), 2026-11-01T09:00Z, or +2h.',
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new InvalidArgumentError(
      'Expected an ISO 8601 date and time, e.g. 2026-11-01T09:00Z, or an offset like +2h.',
    );
  }
  return new Date(ms).toISOString();
}

/** Local `2026-11-01 09:00 (in 6d)` for people; the ISO string itself for pipes. */
export function formatDate(
  iso: string | null | undefined,
  human: boolean,
  now = new Date(),
): string {
  if (!iso) return '-';
  if (!human) return iso;
  const date = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const local = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
  return `${local} (${relativeTime(date, now)})`;
}

export function relativeTime(date: Date, now = new Date()): string {
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const [n, unit] =
    abs < 60_000
      ? [0, '']
      : abs < 3_600_000
        ? [Math.round(abs / 60_000), 'm']
        : abs < 86_400_000
          ? [Math.round(abs / 3_600_000), 'h']
          : [Math.round(abs / 86_400_000), 'd'];
  if (n === 0) return 'just now';
  return diff > 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** `used / limit`, with `unlimited` for a null limit. */
export function formatQuota(used: number, limit: number | null): string {
  return limit === null ? `${used} (unlimited)` : `${used} / ${limit}`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
