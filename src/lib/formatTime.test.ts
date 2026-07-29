import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatTokyoTime, formatRelativeTime } from './formatTime';

describe('formatTokyoTime', () => {
  it('returns null when given null', () => {
    expect(formatTokyoTime(null)).toBeNull();
  });

  it('formats a UTC ISO timestamp as JST (UTC+9), independent of server-local timezone', () => {
    // 2026-07-29T01:47:00.000Z -> 2026-07-29 10:47 JST
    const result = formatTokyoTime('2026-07-29T01:47:00.000Z');
    expect(result).toBe('2026/07/29 10:47 JST');
  });

  it('rolls the date over to the next day when the JST offset crosses midnight', () => {
    // 2026-07-29T23:10:00.000Z -> 2026-07-30T08:10 JST
    const result = formatTokyoTime('2026-07-29T23:10:00.000Z');
    expect(result).toBe('2026/07/30 08:10 JST');
  });
});

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when given null', () => {
    expect(formatRelativeTime(null)).toBeNull();
  });

  it('describes a timestamp a few minutes ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T02:00:00.000Z'));
    expect(formatRelativeTime('2026-07-29T01:47:00.000Z')).toBe('13 minutes ago');
  });

  it('describes a timestamp just now (under a minute)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T02:00:10.000Z'));
    expect(formatRelativeTime('2026-07-29T02:00:00.000Z')).toBe('just now');
  });

  it('describes a timestamp hours ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    expect(formatRelativeTime('2026-07-29T02:00:00.000Z')).toBe('8 hours ago');
  });

  it('describes a timestamp days ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T02:00:00.000Z'));
    expect(formatRelativeTime('2026-07-29T02:00:00.000Z')).toBe('5 days ago');
  });
});
