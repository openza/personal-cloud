-- Bound live-source ownership checks for both legacy and workspace publication.
CREATE INDEX source_descriptors_identity ON source_descriptors(integration_kind,external_id_hash,task_id);

-- One per-cloud key authenticates stateless bootstrap cursors. It never leaves D1.
CREATE TABLE workspace_cursor_key(singleton INTEGER PRIMARY KEY CHECK(singleton=1),key_hex TEXT NOT NULL);
INSERT INTO workspace_cursor_key(singleton,key_hex) VALUES(1,lower(hex(randomblob(32))));

-- Keep new compound changes downloadable as one atomic record, including envelope.
CREATE TRIGGER changes_workspace_response_limit BEFORE INSERT ON changes
WHEN NEW.operation='workspace.changed' AND length(CAST(NEW.payload_json AS BLOB))>1900000
BEGIN
 SELECT RAISE(ABORT,'workspace response too large');
END;
