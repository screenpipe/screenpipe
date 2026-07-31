-- Normalized semantic projections over captured accessibility trees.
--
-- The compact parser tree remains transient. A frame references one immutable
-- parse run, canonical item values are shared across runs, and the join table
-- holds run-local order, hierarchy, and source-node provenance. This avoids a
-- second per-frame JSON document while preserving source-backed retrieval.

CREATE TABLE semantic_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    input_fingerprint BLOB NOT NULL UNIQUE
        CHECK (length(input_fingerprint) = 32),
    parser_id TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    app_platform TEXT NOT NULL
        CHECK (app_platform IN ('macos', 'windows', 'linux')),
    app_id TEXT,
    app_executable TEXT,
    app_version TEXT,
    input_content_hash BLOB NOT NULL
        CHECK (length(input_content_hash) = 8),
    status TEXT NOT NULL
        CHECK (status IN ('handled', 'empty')),
    item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
    text_bytes INTEGER NOT NULL DEFAULT 0 CHECK (text_bytes >= 0),
    parse_duration_us INTEGER NOT NULL DEFAULT 0 CHECK (parse_duration_us >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_semantic_runs_parser
    ON semantic_runs(parser_id, parser_version, schema_version);

CREATE TABLE semantic_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_fingerprint BLOB NOT NULL CHECK (length(entity_fingerprint) = 32),
    version_fingerprint BLOB NOT NULL UNIQUE
        CHECK (length(version_fingerprint) = 32),
    kind TEXT NOT NULL
        CHECK (kind IN ('conversation', 'message', 'document', 'task', 'calendar_event', 'page')),
    item_key TEXT NOT NULL,
    identity_quality TEXT NOT NULL
        CHECK (identity_quality IN ('stable', 'derived', 'ephemeral')),
    title TEXT,
    body TEXT,
    actor TEXT,
    occurred_at TEXT,
    timestamp_precision TEXT,
    status TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_semantic_items_entity
    ON semantic_items(entity_fingerprint);
CREATE INDEX idx_semantic_items_kind_time
    ON semantic_items(kind, occurred_at);

CREATE TABLE semantic_run_items (
    run_id INTEGER NOT NULL,
    local_id TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    parent_local_id TEXT,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    source_node_ids BLOB NOT NULL DEFAULT X'',
    PRIMARY KEY (run_id, local_id),
    UNIQUE (run_id, sort_order),
    FOREIGN KEY (run_id) REFERENCES semantic_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES semantic_items(id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, parent_local_id)
        REFERENCES semantic_run_items(run_id, local_id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_semantic_run_items_item
    ON semantic_run_items(item_id);

-- External-content FTS indexes the canonical item table without storing a
-- second copy of the semantic strings in an FTS content table.
CREATE VIRTUAL TABLE semantic_items_fts USING fts5(
    title,
    body,
    actor,
    status,
    metadata_json,
    content='semantic_items',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER semantic_items_ai AFTER INSERT ON semantic_items BEGIN
    INSERT INTO semantic_items_fts(rowid, title, body, actor, status, metadata_json)
    VALUES (new.id, new.title, new.body, new.actor, new.status, new.metadata_json);
END;

CREATE TRIGGER semantic_items_ad AFTER DELETE ON semantic_items BEGIN
    INSERT INTO semantic_items_fts(
        semantic_items_fts, rowid, title, body, actor, status, metadata_json
    ) VALUES (
        'delete', old.id, old.title, old.body, old.actor, old.status, old.metadata_json
    );
END;

CREATE TRIGGER semantic_items_au AFTER UPDATE ON semantic_items BEGIN
    INSERT INTO semantic_items_fts(
        semantic_items_fts, rowid, title, body, actor, status, metadata_json
    ) VALUES (
        'delete', old.id, old.title, old.body, old.actor, old.status, old.metadata_json
    );
    INSERT INTO semantic_items_fts(rowid, title, body, actor, status, metadata_json)
    VALUES (new.id, new.title, new.body, new.actor, new.status, new.metadata_json);
END;

ALTER TABLE frames ADD COLUMN semantic_run_id INTEGER
    REFERENCES semantic_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_frames_semantic_run_id
    ON frames(semantic_run_id)
    WHERE semantic_run_id IS NOT NULL;
