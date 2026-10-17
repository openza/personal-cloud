-- Keep deletion and compacted-source recovery bounded to one entity's history.
CREATE INDEX changes_by_entity_operation
  ON changes(entity_id, operation, change_seq DESC);

-- Source-less metadata/deletion changes must not make identity recovery scan
-- an entity's entire history. Match the recovery predicate exactly.
CREATE INDEX changes_source_history_by_entity
  ON changes(entity_id, change_seq DESC)
  WHERE coalesce(json_extract(payload_json,'$.task.source.integrationKind'),
                 json_extract(payload_json,'$.source.integrationKind')) IS NOT NULL;
