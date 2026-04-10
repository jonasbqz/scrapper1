import { describe, expect, it } from 'bun:test';
import {
  containsBlockedSearchScript,
  normalizeSearchQuery,
} from './search-abuse.util';

describe('search-abuse util', () => {
  it('normalizes empty searches', () => {
    expect(normalizeSearchQuery(undefined)).toBe('');
    expect(normalizeSearchQuery('   ')).toBe('');
    expect(normalizeSearchQuery(' one piece ')).toBe('one piece');
  });

  it('detects han characters as blocked', () => {
    expect(containsBlockedSearchScript('进击的巨人')).toBe(true);
  });

  it('detects japanese kana as blocked', () => {
    expect(containsBlockedSearchScript('ナルト')).toBe(true);
    expect(containsBlockedSearchScript('ひぐらし')).toBe(true);
  });

  it('detects hangul as blocked', () => {
    expect(containsBlockedSearchScript('나 혼자만 레벨업')).toBe(true);
  });

  it('allows latin searches', () => {
    expect(containsBlockedSearchScript('solo leveling')).toBe(false);
    expect(containsBlockedSearchScript('one piece')).toBe(false);
  });
});
