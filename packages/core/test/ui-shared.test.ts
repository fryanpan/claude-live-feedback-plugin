import { describe, expect, it } from 'vitest';
import { contentKind } from '../src/types.ts';
import { STATUS_COLORS, escapeHtml, formatTime } from '../src/ui-shared.ts';

describe('contentKind', () => {
  it('maps every doc kind to its content surface', () => {
    expect(contentKind('markdown')).toBe('prose');
    expect(contentKind('code')).toBe('flat');
    expect(contentKind('diff')).toBe('flat');
    expect(contentKind('mockup')).toBe('none');
  });
});

describe('formatTime', () => {
  it('formats relative times', () => {
    const now = Date.now();
    expect(formatTime(0)).toBe('');
    expect(formatTime(now - 10_000)).toBe('just now');
    expect(formatTime(now - 5 * 60_000)).toBe('5m');
    expect(formatTime(now - 3 * 3600_000)).toBe('3h');
    expect(formatTime(now - 2 * 86_400_000)).toBe('2d');
    expect(formatTime(now - 30 * 86_400_000)).toMatch(/[A-Z][a-z]{2} \d/);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&z</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;z&lt;/a&gt;',
    );
  });
});

describe('STATUS_COLORS', () => {
  it('has the three thread states', () => {
    expect(Object.keys(STATUS_COLORS).sort()).toEqual(['open', 'orphan', 'resolved']);
  });
});
