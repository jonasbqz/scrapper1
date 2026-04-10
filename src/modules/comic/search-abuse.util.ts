const BLOCKED_SEARCH_SCRIPT_REGEX =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function normalizeSearchQuery(search?: string | null): string {
  return search?.trim() || '';
}

export function containsBlockedSearchScript(search?: string | null): boolean {
  const normalized = normalizeSearchQuery(search);
  if (!normalized) {
    return false;
  }

  return BLOCKED_SEARCH_SCRIPT_REGEX.test(normalized);
}
