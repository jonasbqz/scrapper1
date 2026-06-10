export function parseCorsOrigins(value?: string | null): string[] {
  return (value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function parseTrustedRefererOrigins(value?: string | null): string[] {
  const defaults = [
    'https://mangolibreria.com',
    'https://www.mangolibreria.com',
    'http://localhost:3000',
  ];

  const configured = parseCorsOrigins(value);
  const origins = configured.length > 0 ? configured : defaults;

  return Array.from(
    new Set(
      origins
        .map((entry) => {
          try {
            return new URL(entry).origin;
          } catch {
            return entry;
          }
        })
        .filter(Boolean),
    ),
  );
}
