-- Drop the route_protection_codes table that backed the old 6-digit suffix
-- rotation system. The new format bakes the random into the comic's slug
-- itself (3 random prefix + title + 4 random suffix for protected comics)
-- and uses a Redis-cached random suffix for protected chapters. The DB-side
-- code table is no longer needed.
DROP TABLE IF EXISTS "route_protection_codes";
