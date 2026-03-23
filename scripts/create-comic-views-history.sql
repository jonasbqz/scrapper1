CREATE TABLE IF NOT EXISTS comic_views_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comic_id integer NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
  views integer NOT NULL DEFAULT 0,
  date date NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS comic_views_history_comic_date_idx
  ON comic_views_history (comic_id, date);

CREATE INDEX IF NOT EXISTS comic_views_history_date_idx
  ON comic_views_history (date);
