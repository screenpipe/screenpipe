-- Speed up chat people filters and speaker autocomplete.
CREATE INDEX IF NOT EXISTS idx_speakers_hallucination_name
  ON speakers(hallucination, name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_tags_name_nocase
  ON tags(name COLLATE NOCASE);
