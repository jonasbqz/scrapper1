const EMAIL_VERIFICATION_REQUIRED_CODE = 'EMAIL_VERIFICATION_REQUIRED';
const VERIFICATION_EMAIL_COOLDOWN_CODE = 'VERIFICATION_EMAIL_COOLDOWN';
const VERIFICATION_EMAIL_RESEND_COOLDOWN_MS = 3 * 60 * 1000;
const DEFAULT_EMAIL_VERIFICATION_REQUIRED_FROM = '2026-04-04T00:00:00Z';

function normalizeDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function getEmailVerificationRequiredFrom(): Date | null {
  return normalizeDate(
    process.env.EMAIL_VERIFICATION_REQUIRED_FROM ||
      DEFAULT_EMAIL_VERIFICATION_REQUIRED_FROM,
  );
}

export function isEmailVerificationRequired(params: {
  emailVerified: boolean | null | undefined;
  hasCredentialAccount: boolean;
}) {
  return params.hasCredentialAccount && params.emailVerified !== true;
}

export function isVerificationCleanupEligible(params: {
  createdAt: Date | string | null | undefined;
  emailVerified: boolean | null | undefined;
  hasCredentialAccount: boolean;
}) {
  if (!params.hasCredentialAccount || params.emailVerified === true) {
    return false;
  }

  const cutoff = getEmailVerificationRequiredFrom();
  const createdAt = normalizeDate(params.createdAt);

  if (!cutoff || !createdAt) {
    return false;
  }

  return createdAt.getTime() >= cutoff.getTime();
}

export function getEmailVerificationRequiredError() {
  return {
    code: EMAIL_VERIFICATION_REQUIRED_CODE,
    message:
      'Debes verificar tu correo antes de iniciar sesion o usar funciones de tu cuenta.',
  };
}

export function getEmailVerificationRequiredCode() {
  return EMAIL_VERIFICATION_REQUIRED_CODE;
}

export function getVerificationEmailCooldownCode() {
  return VERIFICATION_EMAIL_COOLDOWN_CODE;
}

export function getVerificationEmailResendCooldownMs() {
  return VERIFICATION_EMAIL_RESEND_COOLDOWN_MS;
}

export function getVerificationEmailCooldownError(retryAfterMs?: number | null) {
  const retryAfterSeconds = retryAfterMs
    ? Math.max(1, Math.ceil(retryAfterMs / 1000))
    : Math.ceil(VERIFICATION_EMAIL_RESEND_COOLDOWN_MS / 1000);

  return {
    code: VERIFICATION_EMAIL_COOLDOWN_CODE,
    retryAfterSeconds,
    message:
      'Debes esperar 3 minutos antes de pedir otro correo de verificacion para este email.',
  };
}
