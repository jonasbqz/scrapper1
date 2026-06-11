CREATE TABLE IF NOT EXISTS "route_protection_codes" (
  "entity_type" text NOT NULL,
  "entity_id" integer NOT NULL,
  "code" varchar(6) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("entity_type", "entity_id"),
  CONSTRAINT "route_protection_codes_entity_type_check"
    CHECK ("entity_type" IN ('comic', 'chapter')),
  CONSTRAINT "route_protection_codes_code_format_check"
    CHECK ("code" ~ '^\d{6}$')
);

CREATE INDEX IF NOT EXISTS "route_protection_codes_lookup_idx"
  ON "route_protection_codes" ("entity_type", "code");
