ALTER TABLE tasks
ADD COLUMN planned_on TEXT CHECK (
  planned_on IS NULL OR
  (length(planned_on) = 10 AND substr(planned_on, 5, 1) = '-' AND substr(planned_on, 8, 1) = '-')
);

ALTER TABLE tasks
ADD COLUMN planned_at TEXT CHECK (
  planned_at IS NULL OR
  (length(planned_at) = 24 AND substr(planned_at, 11, 1) = 'T' AND substr(planned_at, 24, 1) = 'Z')
);
