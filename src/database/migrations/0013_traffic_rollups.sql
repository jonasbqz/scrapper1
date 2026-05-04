CREATE TABLE IF NOT EXISTS "traffic_subject_windows" (
  "subject_key" text NOT NULL,
  "window_start" timestamp NOT NULL,
  "client_ip" varchar(64),
  "client_asn" integer,
  "user_agent" text,
  "user_id" text,
  "last_path" text,
  "last_search_query" text,
  "total_events" integer DEFAULT 0 NOT NULL,
  "search_events" integer DEFAULT 0 NOT NULL,
  "content_events" integer DEFAULT 0 NOT NULL,
  "lookup_events" integer DEFAULT 0 NOT NULL,
  "unique_path_hits" integer DEFAULT 0 NOT NULL,
  "unique_search_hits" integer DEFAULT 0 NOT NULL,
  "max_risk_score" integer DEFAULT 0 NOT NULL,
  "risk_score_sum" integer DEFAULT 0 NOT NULL,
  "risk_samples" integer DEFAULT 0 NOT NULL,
  "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "first_seen_at" timestamp DEFAULT now() NOT NULL,
  "last_seen_at" timestamp DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  PRIMARY KEY ("subject_key", "window_start")
);

CREATE INDEX IF NOT EXISTS "traffic_subject_windows_window_idx"
  ON "traffic_subject_windows" ("window_start");
CREATE INDEX IF NOT EXISTS "traffic_subject_windows_risk_idx"
  ON "traffic_subject_windows" ("max_risk_score", "window_start");
CREATE INDEX IF NOT EXISTS "traffic_subject_windows_ip_idx"
  ON "traffic_subject_windows" ("client_ip", "window_start");
CREATE INDEX IF NOT EXISTS "traffic_subject_windows_asn_idx"
  ON "traffic_subject_windows" ("client_asn", "window_start");

-- Keep the raw event table small. Raw rows are now samples/debug evidence;
-- hourly subject windows are the source for pattern detection.
CREATE INDEX IF NOT EXISTS "traffic_events_subject_risk_occurred_idx"
  ON "traffic_events" ("subject_key", "risk_score", "occurred_at");
