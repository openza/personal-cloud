ALTER TABLE tasks RENAME TO tasks_title_checkpoint;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL CHECK (product = 'tasks'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  title TEXT NOT NULL,
  completion_state TEXT NOT NULL CHECK (completion_state = 'open'),
  workflow_status TEXT NOT NULL CHECK (workflow_status IN ('none', 'inbox', 'next', 'waiting', 'someday')),
  created_at TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version > 0),
  created_by_mutation_id TEXT NOT NULL UNIQUE
);

INSERT INTO tasks
  (id, product, space_id, title, completion_state, workflow_status, created_at,
   entity_version, created_by_mutation_id)
SELECT id, product, space_id, title, completion_state, workflow_status, created_at,
       entity_version, created_by_mutation_id
FROM tasks_title_checkpoint;

DROP TABLE tasks_title_checkpoint;
