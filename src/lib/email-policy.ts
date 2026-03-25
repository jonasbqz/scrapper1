export const ALLOWED_PERSONAL_EMAIL_DOMAINS = [
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'proton.me',
] as const;

export function normalizeEmailDomain(email: string | null | undefined) {
  if (!email) {
    return null;
  }

  const parts = email.trim().toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : null;
}

export function isAllowedPersonalEmailDomain(email: string | null | undefined) {
  const domain = normalizeEmailDomain(email);
  return !!domain && ALLOWED_PERSONAL_EMAIL_DOMAINS.includes(
    domain as (typeof ALLOWED_PERSONAL_EMAIL_DOMAINS)[number],
  );
}

export function getAllowedPersonalEmailDomainsLabel() {
  return ALLOWED_PERSONAL_EMAIL_DOMAINS.join(', ');
}
