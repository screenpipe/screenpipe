-- Durable, correctable actor identities for semantic items.
--
-- Parsers keep their immutable observed actor label on semantic_items. These
-- tables hold the provisional identity assigned to that observation so a user
-- or Pipe can rename, merge, or reassign actors without rewriting source-backed
-- parser output. Aliases survive semantic-item retention so reconciliations keep
-- applying to future captures.

CREATE TABLE semantic_actors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
        CHECK (length(trim(name)) BETWEEN 1 AND 256),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_semantic_actors_name
    ON semantic_actors(name COLLATE NOCASE);

CREATE TABLE semantic_actor_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER NOT NULL,
    source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 1024),
    source_label TEXT NOT NULL CHECK (length(source_label) BETWEEN 1 AND 256),
    normalized_label TEXT NOT NULL
        CHECK (length(normalized_label) BETWEEN 1 AND 512),
    observed_label TEXT NOT NULL
        CHECK (length(trim(observed_label)) BETWEEN 1 AND 256),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (source_key, normalized_label),
    FOREIGN KEY (actor_id) REFERENCES semantic_actors(id) ON DELETE CASCADE
);

CREATE INDEX idx_semantic_actor_aliases_actor
    ON semantic_actor_aliases(actor_id);
CREATE INDEX idx_semantic_actor_aliases_observed_label
    ON semantic_actor_aliases(observed_label COLLATE NOCASE);

CREATE TABLE semantic_item_actors (
    item_id INTEGER PRIMARY KEY,
    actor_id INTEGER NOT NULL,
    observed_alias_id INTEGER,
    assignment_source TEXT NOT NULL DEFAULT 'heuristic'
        CHECK (assignment_source IN ('heuristic', 'reconciled')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (item_id) REFERENCES semantic_items(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES semantic_actors(id) ON DELETE RESTRICT,
    FOREIGN KEY (observed_alias_id)
        REFERENCES semantic_actor_aliases(id) ON DELETE SET NULL
);

CREATE INDEX idx_semantic_item_actors_actor
    ON semantic_item_actors(actor_id, item_id);
