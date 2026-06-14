-- Speeds up bot-risk suspicious subject rollups filtered by window_start + risk thresholds.
CREATE INDEX IF NOT EXISTS "traffic_subject_windows_window_risk_subject_idx"
  ON "traffic_subject_windows" ("window_start" DESC, "max_risk_score" DESC, "subject_key");
