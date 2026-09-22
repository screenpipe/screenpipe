// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::{storage_error, StorageDescriptor};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection};

/// Execute trusted construction statements while the offline lifecycle owns
/// the writer permit. Callers supply simple DDL/DML, without trigger bodies or
/// semicolons inside literals. Each completed statement releases its WAL pages
/// before the next operation; normal capture keeps its shared checkpoint policy.
pub(super) async fn construction_sql(
    conn: &mut SqliteConnection,
    sql: &str,
) -> Result<(), sqlx::Error> {
    for statement in sql.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
            .execute(&mut *conn)
            .await?;
        construction_checkpoint(conn).await?;
        super::faults::checkpoint("migration_schema_step");
    }
    Ok(())
}

pub(super) async fn construction_checkpoint(
    conn: &mut SqliteConnection,
) -> Result<(), sqlx::Error> {
    // In-place schema steps commit their DDL and resume marker together. Their
    // caller checkpoints after commit, never inside the schema transaction.
    let mut handle = conn.lock_handle().await?;
    let in_transaction =
        unsafe { libsqlite3_sys::sqlite3_get_autocommit(handle.as_raw_handle().as_ptr()) == 0 };
    drop(handle);
    if in_transaction {
        return Ok(());
    }
    // Let finishing cursors drain within the connection's busy timeout. FULL
    // copies committed frames without requesting a WAL restart under the pools.
    super::diagnostics::stage("checkpointing_wal");
    let row = sqlx::query("PRAGMA wal_checkpoint(FULL)")
        .fetch_one(&mut *conn)
        .await?;
    let busy: i64 = row.try_get(0)?;
    let pages: i64 = row.try_get(1)?;
    let copied: i64 = row.try_get(2)?;
    if busy != 0 || pages != copied {
        return Err(storage_error(format!(
            "offline construction checkpoint incomplete (busy={busy}, wal_pages={pages}, checkpointed={copied})"
        )));
    }
    Ok(())
}

pub(super) async fn converted_step(
    conn: &mut SqliteConnection,
    step: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _storage_conversion_steps WHERE step=?)")
        .bind(step)
        .fetch_one(conn)
        .await
}

pub(super) async fn finish_step(
    conn: &mut SqliteConnection,
    step: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO _storage_conversion_steps(step) VALUES(?)")
        .bind(step)
        .execute(conn)
        .await?;
    Ok(())
}

/// Install only the catalog/trigger definitions. Historical payloads are
/// registered and sealed one batch at a time by the offline conversion loop.
pub(super) async fn bootstrap_in_place(
    conn: &mut SqliteConnection,
    descriptor: &StorageDescriptor,
) -> Result<(), sqlx::Error> {
    if !converted_step(conn, "frames-schema").await? {
        let mut tx = conn.begin().await?;
        for statement in CATALOG.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            if statement.starts_with("INSERT INTO frames_fts")
                || statement.starts_with("UPDATE frames SET")
            {
                continue;
            }
            sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("INSERT INTO storage_metadata(singleton,descriptor,staging_limit,record_limit,policy,required_surfaces,writer_version) VALUES(1,?,?,?,?,?,?)")
            .bind(serde_json::to_string(descriptor).map_err(storage_error)?)
            .bind(descriptor.budget.staging_bytes as i64).bind(descriptor.budget.record_bytes as i64)
            .bind(&descriptor.privacy.identity).bind(descriptor.privacy.required_surfaces as i64)
            .bind(env!("CARGO_PKG_VERSION")).execute(&mut *tx).await?;
        sqlx::raw_sql(sqlx::AssertSqlSafe(triggers()))
            .execute(&mut *tx)
            .await?;
        let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND substr(name,1,1)!='_' AND name NOT IN ('frames','frame_payloads','payload_files','storage_metadata','upload_bindings') AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'").fetch_all(&mut *tx).await?;
        for table in tables {
            for event in ["INSERT", "UPDATE", "DELETE"] {
                let name = table.replace('"', "\"\"");
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE TRIGGER \"hybrid_revision_{name}_{event}\" AFTER {event} ON \"{name}\" BEGIN UPDATE storage_metadata SET revision=revision+1; END;"))).execute(&mut *tx).await?;
            }
        }
        sqlx::query("INSERT INTO _hybrid_migrations VALUES(1,?)")
            .bind(format!(
                "{:x}",
                Sha256::digest(format!("{CATALOG}{}", triggers()))
            ))
            .execute(&mut *tx)
            .await?;
        finish_step(&mut tx, "frames-schema").await?;
        tx.commit().await?;
        construction_checkpoint(conn).await?;
        super::faults::checkpoint("migration_schema_step");
    }
    super::bulk::bootstrap_in_place(conn).await?;
    upgrade_resident_frames(conn).await
}

pub(super) async fn stage_frames(
    conn: &mut SqliteConnection,
    first: i64,
    last: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE storage_metadata SET maintenance=1")
        .execute(&mut *conn)
        .await?;
    let flags = CATALOG
        .rsplit_once("UPDATE frames SET ")
        .unwrap()
        .1
        .trim()
        .trim_end_matches(';');
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE frames SET {flags} WHERE id BETWEEN ? AND ?"
    )))
    .bind(first)
    .bind(last)
    .execute(&mut *conn)
    .await?;
    sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO frame_payloads(frame_id,generation,state,bytes,policy,completed_surfaces) SELECT NEW.id,1,'staged',({BYTES}),?,{EMPTY_SURFACES} FROM frames NEW WHERE NEW.id BETWEEN ? AND ?")))
        .bind(sqlx::query_scalar::<_, String>("SELECT policy FROM storage_metadata").fetch_one(&mut *conn).await?)
        .bind(first).bind(last).execute(&mut *conn).await?;
    sqlx::query("INSERT INTO frames_fts(rowid,full_text,app_name,window_name,browser_url) SELECT id,full_text,COALESCE(app_name,''),COALESCE(window_name,''),COALESCE(browser_url,'') FROM frames WHERE id BETWEEN ? AND ? AND full_text IS NOT NULL AND full_text!=''")
        .bind(first).bind(last).execute(&mut *conn).await?;
    sqlx::query("UPDATE storage_metadata SET maintenance=0,staging_bytes=staging_bytes+COALESCE((SELECT sum(bytes) FROM frame_payloads WHERE frame_id BETWEEN ? AND ? AND bytes<=record_limit),0)").bind(first).bind(last).execute(conn).await?;
    Ok(())
}

/// Backfill by primary-key windows so construction WAL is reused between
/// batches. Both statements are static SQL supplied by schema construction.
pub(super) async fn construction_rows(
    conn: &mut SqliteConnection,
    statement: &str,
    source: &str,
    batch_rows: usize,
) -> Result<(), sqlx::Error> {
    let mut after = None;
    loop {
        let lower = after.map_or_else(|| "1".to_owned(), |id: i64| format!("id>{id}"));
        let last: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT max(id) FROM (SELECT id FROM {source} WHERE {lower} ORDER BY id LIMIT {batch_rows})"
        )))
        .fetch_one(&mut *conn)
        .await?;
        let Some(last) = last else { break };
        construction_sql(conn, &format!("{statement} WHERE {lower} AND id<={last}")).await?;
        after = Some(last);
    }
    Ok(())
}

pub(super) const LEGACY_FTS: &str =
    include_str!("../migrations/20260415000000_frames_fts_external_content.sql");

pub(super) fn hybrid_fts_schema() -> &'static str {
    let start = CATALOG.find("CREATE VIRTUAL TABLE frames_fts").unwrap();
    &CATALOG[start..start + CATALOG[start..].find(';').unwrap()]
}

const CATALOG: &str = r#"
CREATE TABLE _hybrid_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL);
CREATE TABLE storage_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), descriptor TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, maintenance INTEGER NOT NULL DEFAULT 0,
    staging_bytes INTEGER NOT NULL DEFAULT 0, staging_limit INTEGER NOT NULL,
    record_limit INTEGER NOT NULL, policy TEXT NOT NULL, required_surfaces INTEGER NOT NULL,
    writer_version TEXT NOT NULL
);
CREATE TABLE upload_bindings (
    destination TEXT PRIMARY KEY, checkpoint TEXT NOT NULL
);
CREATE TABLE payload_files (
    id TEXT PRIMARY KEY, search_path TEXT NOT NULL UNIQUE, detail_path TEXT NOT NULL UNIQUE,
    search_checksum TEXT, detail_checksum TEXT, schema_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('encoding','published','dirty','retired')),
    row_count INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE frame_payloads (
    frame_id INTEGER PRIMARY KEY REFERENCES frames(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK(generation > 0),
    state TEXT NOT NULL CHECK(state IN ('staged','sealed')),
    file_id TEXT REFERENCES payload_files(id), bytes INTEGER NOT NULL,
    policy TEXT NOT NULL, completed_surfaces INTEGER NOT NULL DEFAULT 0,
    capture_version TEXT, archive_writer_version TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, last_error TEXT,
    CHECK((state='staged' AND file_id IS NULL) OR (state='sealed' AND file_id IS NOT NULL))
);
CREATE INDEX frame_payloads_file ON frame_payloads(file_id);
CREATE INDEX frame_payloads_staging ON frame_payloads(state,frame_id);
ALTER TABLE frames ADD COLUMN payload_full_text_length INTEGER NOT NULL DEFAULT 0;
ALTER TABLE frames ADD COLUMN payload_accessibility_length INTEGER NOT NULL DEFAULT 0;
ALTER TABLE frames ADD COLUMN payload_full_text_present INTEGER NOT NULL DEFAULT 0;
ALTER TABLE frames ADD COLUMN payload_accessibility_present INTEGER NOT NULL DEFAULT 0;
ALTER TABLE frames ADD COLUMN payload_detail_present INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER IF EXISTS frames_ai;
DROP TRIGGER IF EXISTS frames_au;
DROP TRIGGER IF EXISTS frames_ad;
DROP TABLE frames_fts;
CREATE VIRTUAL TABLE frames_fts USING fts5(full_text,app_name,window_name,browser_url,
    content='',contentless_delete=1,tokenize='unicode61');
INSERT INTO frames_fts(rowid,full_text,app_name,window_name,browser_url)
SELECT id,full_text,COALESCE(app_name,''),COALESCE(window_name,''),COALESCE(browser_url,'')
FROM frames WHERE full_text IS NOT NULL AND full_text != '';
UPDATE frames SET payload_full_text_length=length(COALESCE(full_text,'')),
    payload_accessibility_length=length(COALESCE(accessibility_text,'')),
    payload_full_text_present=full_text IS NOT NULL,
    payload_accessibility_present=accessibility_text IS NOT NULL,
    payload_detail_present=accessibility_tree_json IS NOT NULL OR text_json IS NOT NULL;
"#;

pub(super) const BYTES: &str = "COALESCE(length(CAST(NEW.full_text AS BLOB)),0)+COALESCE(length(CAST(NEW.accessibility_text AS BLOB)),0)+COALESCE(length(CAST(NEW.accessibility_tree_json AS BLOB)),0)+COALESCE(length(CAST(NEW.text_json AS BLOB)),0)";
const EMPTY_SURFACES: &str = "(CASE WHEN COALESCE(NEW.full_text,'')='' THEN 1 ELSE 0 END | CASE WHEN COALESCE(NEW.accessibility_text,'')='' THEN 2 ELSE 0 END | CASE WHEN COALESCE(NEW.accessibility_tree_json,'')='' THEN 4 ELSE 0 END | CASE WHEN COALESCE(NEW.text_json,'')='' THEN 8 ELSE 0 END | CASE WHEN COALESCE(NEW.window_name,'')='' THEN 16 ELSE 0 END | CASE WHEN COALESCE(NEW.browser_url,'')='' THEN 32 ELSE 0 END)";

fn triggers() -> String {
    // Version 1's checksum is part of existing generation identities.
    frame_triggers(false, false)
}

// Keep the v1/v4 SQL byte-for-byte stable for installed schema checksums.
fn frame_triggers(retain_oversized: bool, recording: bool) -> String {
    let charge = |bytes: &str| {
        if retain_oversized {
            format!("CASE WHEN ({bytes}) <= (SELECT record_limit FROM storage_metadata) THEN ({bytes}) ELSE 0 END")
        } else {
            bytes.to_owned()
        }
    };
    let new_staging_bytes = charge(BYTES);
    let prior_staging_bytes = charge("bytes");
    let growth_guard = if retain_oversized {
        format!(" AND ({BYTES}) > ({})", BYTES.replace("NEW.", "OLD."))
    } else {
        String::new()
    };
    let insert_admission = if recording {
        String::new()
    } else {
        format!(
            r#"
    SELECT CASE WHEN ({BYTES}) > (SELECT record_limit FROM storage_metadata)
        THEN RAISE(ABORT,'frame storage: record budget exceeded') END;
    SELECT CASE WHEN (SELECT staging_bytes+({BYTES})>staging_limit FROM storage_metadata)
        THEN RAISE(ABORT,'frame storage: staging budget reached; capture admission paused') END;"#
        )
    };
    let update_admission = if recording {
        String::new()
    } else {
        format!(
            r#"
    SELECT CASE WHEN ({BYTES}) > (SELECT record_limit FROM storage_metadata){growth_guard}
        THEN RAISE(ABORT,'frame storage: record budget exceeded') END;"#
        )
    };
    let staging_admission = if recording {
        ""
    } else {
        "\n    SELECT CASE WHEN (SELECT staging_bytes>staging_limit FROM storage_metadata)\n        THEN RAISE(ABORT,'frame storage: staging budget reached; capture admission paused') END;"
    };
    let inserted_bytes = if recording { &new_staging_bytes } else { BYTES };
    format!(
        r#"
CREATE TRIGGER hybrid_frame_insert AFTER INSERT ON frames
WHEN (SELECT maintenance=0 FROM storage_metadata WHERE singleton=1)
BEGIN{insert_admission}
    INSERT INTO frame_payloads(frame_id,generation,state,bytes,policy,completed_surfaces,capture_version)
    SELECT NEW.id,1,'staged',({BYTES}),policy,{EMPTY_SURFACES},writer_version FROM storage_metadata;
    UPDATE storage_metadata SET staging_bytes=staging_bytes+({inserted_bytes}),revision=revision+1;
    UPDATE frames SET payload_full_text_length=length(COALESCE(NEW.full_text,'')),
        payload_accessibility_length=length(COALESCE(NEW.accessibility_text,'')),
        payload_full_text_present=NEW.full_text IS NOT NULL,
        payload_accessibility_present=NEW.accessibility_text IS NOT NULL,
        payload_detail_present=NEW.accessibility_tree_json IS NOT NULL OR NEW.text_json IS NOT NULL
    WHERE id=NEW.id;
    INSERT INTO frames_fts(rowid,full_text,app_name,window_name,browser_url)
    SELECT NEW.id,NEW.full_text,COALESCE(NEW.app_name,''),COALESCE(NEW.window_name,''),COALESCE(NEW.browser_url,'')
    WHERE NEW.full_text IS NOT NULL AND NEW.full_text != '';
END;
CREATE TRIGGER hybrid_frame_sealed_guard BEFORE UPDATE OF full_text,accessibility_text,accessibility_tree_json,text_json,app_name,window_name,browser_url ON frames
WHEN (SELECT maintenance=0 FROM storage_metadata) AND
     (SELECT state='sealed' FROM frame_payloads WHERE frame_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'frame storage: sealed frame requires coordinated payload replacement'); END;
CREATE TRIGGER hybrid_frame_update AFTER UPDATE OF full_text,accessibility_text,accessibility_tree_json,text_json,app_name,window_name,browser_url ON frames
WHEN (SELECT maintenance=0 FROM storage_metadata)
BEGIN{update_admission}
    UPDATE storage_metadata SET revision=revision+1,
        staging_bytes=staging_bytes+({new_staging_bytes})-(SELECT {prior_staging_bytes} FROM frame_payloads WHERE frame_id=NEW.id);{staging_admission}
    UPDATE frame_payloads SET generation=generation+1,bytes=({BYTES}),
        policy=(SELECT policy FROM storage_metadata),completed_surfaces={EMPTY_SURFACES},attempts=0,retry_at=NULL,last_error=NULL
    WHERE frame_id=NEW.id;
    UPDATE frames SET payload_full_text_length=length(COALESCE(NEW.full_text,'')),
        payload_accessibility_length=length(COALESCE(NEW.accessibility_text,'')),
        payload_full_text_present=NEW.full_text IS NOT NULL,
        payload_accessibility_present=NEW.accessibility_text IS NOT NULL,
        payload_detail_present=NEW.accessibility_tree_json IS NOT NULL OR NEW.text_json IS NOT NULL
    WHERE id=NEW.id;
    DELETE FROM frames_fts WHERE rowid=OLD.id;
    INSERT INTO frames_fts(rowid,full_text,app_name,window_name,browser_url)
    SELECT NEW.id,NEW.full_text,COALESCE(NEW.app_name,''),COALESCE(NEW.window_name,''),COALESCE(NEW.browser_url,'')
    WHERE NEW.full_text IS NOT NULL AND NEW.full_text != '';
END;
CREATE TRIGGER hybrid_frame_metadata AFTER UPDATE OF timestamp,offset_index,device_name,focused,video_chunk_id,frame_name ON frames
WHEN (SELECT maintenance=0 FROM storage_metadata)
BEGIN UPDATE storage_metadata SET revision=revision+1; END;
CREATE TRIGGER hybrid_frame_delete BEFORE DELETE ON frames
BEGIN
    DELETE FROM frames_fts WHERE rowid=OLD.id;
    UPDATE payload_files SET state='dirty' WHERE id=(SELECT file_id FROM frame_payloads WHERE frame_id=OLD.id);
    UPDATE storage_metadata SET revision=revision+1,staging_bytes=staging_bytes-
        COALESCE((SELECT {prior_staging_bytes} FROM frame_payloads WHERE frame_id=OLD.id AND state='staged'),0);
    DELETE FROM frame_payloads WHERE frame_id=OLD.id;
END;
"#
    )
}

/// Keep legacy frames above the encoder budget resident without consuming the
/// capture backlog. Runs under the existing startup/offline writer, including
/// for generations left midway through migration by an older app.
pub(crate) async fn upgrade_resident_frames(
    conn: &mut SqliteConnection,
) -> Result<(), sqlx::Error> {
    let sql = frame_triggers(true, false);
    let checksum = format!("{:x}", Sha256::digest(format!("{sql}:resident-frames-v1")));
    let installed: Option<String> =
        sqlx::query_scalar("SELECT checksum FROM _hybrid_migrations WHERE version=4")
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(installed) = installed {
        return if installed == checksum {
            Ok(())
        } else {
            Err(storage_error("resident frame schema checksum mismatch"))
        };
    }
    let mut tx = conn.begin().await?;
    sqlx::query("UPDATE storage_metadata SET staging_bytes=staging_bytes-COALESCE((SELECT sum(bytes) FROM frame_payloads WHERE state='staged' AND bytes>record_limit),0)")
        .execute(&mut *tx).await?;
    for name in [
        "hybrid_frame_insert",
        "hybrid_frame_update",
        "hybrid_frame_delete",
        "hybrid_frame_sealed_guard",
        "hybrid_frame_metadata",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO _hybrid_migrations VALUES(4,?)")
        .bind(checksum)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Archival budgets never reject recording. Replace the v1/v4/v5 write guards
/// atomically without changing their recorded identities or resident bytes.
pub(crate) async fn upgrade_recording(
    conn: &mut SqliteConnection,
    has_bulk: bool,
) -> Result<bool, sqlx::Error> {
    let sql = frame_triggers(true, true);
    let checksum = format!("{:x}", Sha256::digest(format!("{sql}:recording-v6")));
    let installed: Option<String> =
        sqlx::query_scalar("SELECT checksum FROM _hybrid_migrations WHERE version=6")
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(installed) = installed {
        return if installed == checksum {
            Ok(false)
        } else {
            Err(storage_error("recording schema checksum mismatch"))
        };
    }
    let mut tx = conn.begin().await?;
    for name in ["insert", "update", "delete", "sealed_guard", "metadata"] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "DROP TRIGGER hybrid_frame_{name}"
        )))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(&mut *tx)
        .await?;
    if has_bulk {
        super::bulk::upgrade_recording(&mut tx).await?;
    }
    sqlx::query("INSERT INTO _hybrid_migrations VALUES(6,?)")
        .bind(checksum)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

pub(crate) async fn bootstrap(
    conn: &mut SqliteConnection,
    descriptor: &StorageDescriptor,
) -> Result<(), sqlx::Error> {
    let (catalog, flags) = CATALOG.rsplit_once("UPDATE frames SET ").unwrap();
    construction_sql(conn, catalog).await?;
    construction_rows(
        conn,
        &format!("UPDATE frames SET {}", flags.trim().trim_end_matches(';')),
        "frames",
        128,
    )
    .await?;
    sqlx::query("INSERT INTO storage_metadata(singleton,descriptor,staging_limit,record_limit,policy,required_surfaces,writer_version) VALUES(1,?,?,?,?,?,?)")
        .bind(serde_json::to_string(descriptor).map_err(storage_error)?)
        .bind(descriptor.budget.staging_bytes as i64).bind(descriptor.budget.record_bytes as i64)
        .bind(&descriptor.privacy.identity).bind(descriptor.privacy.required_surfaces as i64)
        .bind(env!("CARGO_PKG_VERSION")).execute(&mut *conn).await?;
    let seed = format!("INSERT INTO frame_payloads(frame_id,generation,state,bytes,policy,completed_surfaces) SELECT NEW.id,1,'staged',({BYTES}),?,{EMPTY_SURFACES} FROM frames NEW");
    sqlx::query(sqlx::AssertSqlSafe(seed))
        .bind(&descriptor.privacy.identity)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE storage_metadata SET staging_bytes=COALESCE((SELECT SUM(bytes) FROM frame_payloads),0)")
        .execute(&mut *conn).await?;
    sqlx::raw_sql(sqlx::AssertSqlSafe(triggers()))
        .execute(&mut *conn)
        .await?;
    // Resident text and relationships participate in the same read revision.
    let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND substr(name,1,1)!='_' AND name NOT IN ('frames','frame_payloads','payload_files','storage_metadata','upload_bindings') AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'")
        .fetch_all(&mut *conn).await?;
    for table in tables {
        for event in ["INSERT", "UPDATE", "DELETE"] {
            let sql = format!("CREATE TRIGGER hybrid_revision_{table}_{event} AFTER {event} ON {table} BEGIN UPDATE storage_metadata SET revision=revision+1; END;");
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut *conn)
                .await?;
        }
    }
    let checksum = format!("{:x}", Sha256::digest(format!("{CATALOG}{}", triggers())));
    sqlx::query("INSERT INTO _hybrid_migrations VALUES(1,?)")
        .bind(checksum)
        .execute(&mut *conn)
        .await?;
    if descriptor
        .capabilities
        .iter()
        .any(|s| s == super::bulk::CAPABILITY)
    {
        super::bulk::bootstrap(conn).await?;
    }
    Ok(())
}

pub(crate) async fn verify(
    conn: &mut SqliteConnection,
    descriptor: &StorageDescriptor,
) -> Result<(), sqlx::Error> {
    let row = sqlx::query("SELECT descriptor,maintenance FROM storage_metadata WHERE singleton=1")
        .fetch_one(&mut *conn)
        .await?;
    let stored: StorageDescriptor =
        serde_json::from_str(row.try_get("descriptor")?).map_err(storage_error)?;
    if &stored != descriptor || row.try_get::<i64, _>("maintenance")? != 0 {
        return Err(storage_error("descriptor/catalog identity mismatch"));
    }
    let checksum: String =
        sqlx::query_scalar("SELECT checksum FROM _hybrid_migrations WHERE version=1")
            .fetch_one(&mut *conn)
            .await?;
    if checksum != format!("{:x}", Sha256::digest(format!("{CATALOG}{}", triggers()))) {
        return Err(storage_error("hybrid schema checksum mismatch"));
    }
    if descriptor
        .capabilities
        .iter()
        .any(|s| s == super::bulk::CAPABILITY)
    {
        let checksum: String =
            sqlx::query_scalar("SELECT checksum FROM _hybrid_migrations WHERE version=2")
                .fetch_one(&mut *conn)
                .await?;
        if checksum != super::bulk::manifest_checksum() {
            return Err(storage_error("bulk schema checksum mismatch"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod checkpoint_tests {
    use super::*;
    use sqlx::Connection;
    use std::time::Duration;

    #[tokio::test]
    async fn recording_upgrade_replaces_existing_guards_once() {
        use crate::storage::{MigrationOptions, PrivacyPolicy};
        use crate::DatabaseManager;

        for had_v5 in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let options = MigrationOptions {
                privacy: PrivacyPolicy {
                    identity: "private".into(),
                    required_surfaces: 1,
                },
                ..Default::default()
            };
            let db = DatabaseManager::new_hybrid(root.path(), Default::default(), options)
                .await
                .unwrap();
            db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-17','original'); INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(1,'2026-09-17','text','original'); UPDATE storage_metadata SET staging_limit=1;").await.unwrap();
            let identities: Vec<(i64, String)> = sqlx::query_as(
                "SELECT version,checksum FROM _hybrid_migrations WHERE version<5 ORDER BY version",
            )
            .fetch_all(&db.pool)
            .await
            .unwrap();
            let mut tx = db.begin_immediate_with_retry().await.unwrap();
            let mut legacy = frame_triggers(true, false);
            if had_v5 {
                let charge = |bytes: &str| {
                    format!("CASE WHEN ({bytes}) <= (SELECT record_limit FROM storage_metadata) THEN ({bytes}) ELSE 0 END")
                };
                let guard =
                    "SELECT CASE WHEN (SELECT staging_bytes>staging_limit FROM storage_metadata)";
                legacy = legacy.replace(guard, &format!("SELECT CASE WHEN ({})>({}) AND (SELECT staging_bytes>staging_limit FROM storage_metadata)", charge(BYTES), charge(&BYTES.replace("NEW.", "OLD."))));
                sqlx::query("INSERT INTO _hybrid_migrations VALUES(5,?)")
                    .bind(format!("{:x}", Sha256::digest("staging-drain-v1")))
                    .execute(&mut **tx.conn())
                    .await
                    .unwrap();
            }
            for name in ["insert", "update", "delete", "sealed_guard", "metadata"] {
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                    "DROP TRIGGER hybrid_frame_{name}"
                )))
                .execute(&mut **tx.conn())
                .await
                .unwrap();
            }
            sqlx::raw_sql(sqlx::AssertSqlSafe(legacy))
                .execute(&mut **tx.conn())
                .await
                .unwrap();
            // Restore the earlier bulk admission checks on existing tables.
            for (name, growth) in [
                ("hybrid_bulk_ui_events_text_content", "COALESCE(length(CAST(NEW.text_content AS BLOB)),0)>CASE WHEN (OLD._archive_mask & 1)!=0 THEN COALESCE(length(CAST(OLD.text_content AS BLOB)),0) ELSE 0 END AND "),
                ("hybrid_bulk_pipe_executions_insert", "COALESCE(length(CAST(NEW.stdout AS BLOB)),0)>0 AND "),
            ] {
                let sql: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name=?").bind(name).fetch_one(&mut **tx.conn()).await.unwrap();
                let guard = format!("BEGIN SELECT CASE WHEN {}(SELECT staging_bytes>staging_limit FROM storage_metadata) THEN RAISE(ABORT,'storage staging budget reached') END;", if had_v5 { growth } else { "" });
                let sql = sql.replacen("BEGIN", &guard, 1);
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}; {sql}"))).execute(&mut **tx.conn()).await.unwrap();
            }
            sqlx::query("DELETE FROM _hybrid_migrations WHERE version=6")
                .execute(&mut **tx.conn())
                .await
                .unwrap();
            tx.commit().await.unwrap();
            assert!(db
                .execute_raw_sql_write(
                    "INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-09-17','capture')"
                )
                .await
                .is_err());
            assert!(db
                .execute_raw_sql_write(
                    "UPDATE ui_events SET text_content='growing capture payload' WHERE id=1"
                )
                .await
                .is_err());
            let mut expected_bytes: i64 =
                sqlx::query_scalar("SELECT staging_bytes FROM storage_metadata")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap();
            db.close().await;
            for iteration in 0..2 {
                let db = DatabaseManager::new(
                    root.path().join("db.sqlite").to_str().unwrap(),
                    Default::default(),
                )
                .await
                .unwrap();
                // No warm-up SQL on a writer: the first application write must work.
                let mut tx = db.begin_immediate_with_retry().await.unwrap();
                sqlx::query(
                    "INSERT INTO frames(timestamp,full_text) VALUES('2026-09-17','capture')",
                )
                .execute(&mut **tx.conn())
                .await
                .unwrap();
                tx.commit().await.unwrap();
                expected_bytes += "capture".len() as i64;
                assert_eq!(
                    sqlx::query_scalar::<_, i64>("SELECT staging_bytes FROM storage_metadata")
                        .fetch_one(&db.pool)
                        .await
                        .unwrap(),
                    expected_bytes
                );
                db.execute_raw_sql_write("UPDATE ui_events SET text_content='growing capture payload' WHERE id=1; INSERT INTO pipe_executions(pipe_name,status,stdout) VALUES('test','running','new payload')").await.unwrap();
                assert_eq!(sqlx::query_as::<_,(i64,String)>("SELECT version,checksum FROM _hybrid_migrations WHERE version<5 ORDER BY version").fetch_all(&db.pool).await.unwrap(), identities);
                assert_eq!(
                    sqlx::query_scalar::<_, i64>(
                        "SELECT count(*) FROM _hybrid_migrations WHERE version=6"
                    )
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                    1
                );
                if had_v5 {
                    assert_eq!(
                        sqlx::query_scalar::<_, String>(
                            "SELECT checksum FROM _hybrid_migrations WHERE version=5"
                        )
                        .fetch_one(&db.pool)
                        .await
                        .unwrap(),
                        format!("{:x}", Sha256::digest("staging-drain-v1"))
                    );
                }
                expected_bytes = sqlx::query_scalar("SELECT staging_bytes FROM storage_metadata")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap();
                assert!(expected_bytes > 1, "iteration {iteration}");
                db.verify_storage().await.unwrap();
                db.close().await;
            }
        }
    }

    #[tokio::test]
    #[ignore = "manual old/new capture write throughput comparison"]
    async fn recording_write_cost() {
        let root = tempfile::tempdir().unwrap();
        let db =
            crate::DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
                .await
                .unwrap();
        let payload = "x".repeat(4096);
        for round in 0..6 {
            let recording = round % 2 != 0;
            let mut tx = db.begin_immediate_with_retry().await.unwrap();
            for name in ["insert", "update", "delete", "sealed_guard", "metadata"] {
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                    "DROP TRIGGER hybrid_frame_{name}"
                )))
                .execute(&mut **tx.conn())
                .await
                .unwrap();
            }
            sqlx::raw_sql(sqlx::AssertSqlSafe(frame_triggers(true, recording)))
                .execute(&mut **tx.conn())
                .await
                .unwrap();
            tx.commit().await.unwrap();
            let start = std::time::Instant::now();
            for batch in 0..20 {
                let mut tx = db.begin_immediate_with_retry().await.unwrap();
                sqlx::query("SELECT name FROM main.sqlite_schema LIMIT 1")
                    .fetch_optional(&mut **tx.conn())
                    .await
                    .unwrap();
                for row in 0..50 {
                    sqlx::query(
                        "INSERT INTO frames(id,timestamp,full_text) VALUES(?,'2026-09-17',?)",
                    )
                    .bind(batch * 50 + row + 1)
                    .bind(&payload)
                    .execute(&mut **tx.conn())
                    .await
                    .unwrap();
                }
                tx.commit().await.unwrap();
            }
            eprintln!(
                "{}: 1000 4-KiB captures / 20 commits in {:?}",
                if recording { "new" } else { "old" },
                start.elapsed()
            );
            db.execute_raw_sql_write("DELETE FROM frames")
                .await
                .unwrap();
        }
        db.close().await;
    }

    #[tokio::test]
    async fn upgrades_existing_oversized_frame_accounting_once_without_changing_v1_identity() {
        use crate::storage::{MigrationOptions, Projection, StorageBudget};
        use crate::DatabaseManager;

        // Check against the shipped schema, not a checksum generated by this test.
        assert_eq!(
            format!("{:x}", Sha256::digest(format!("{CATALOG}{}", triggers()))),
            "f6e17a76ded55aeb312b6c7a15fb6498289f38881f3f860629931790802ed81d"
        );
        let root = tempfile::tempdir().unwrap();
        let options = MigrationOptions {
            budget: StorageBudget {
                record_bytes: 1024 * 1024,
                staging_bytes: 1024 * 1024,
                ..Default::default()
            },
            ..Default::default()
        };
        let db = DatabaseManager::new_hybrid(root.path(), Default::default(), options)
            .await
            .unwrap();
        let mut tx = db.begin_immediate_with_retry().await.unwrap();
        for name in ["insert", "update", "delete", "sealed_guard", "metadata"] {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "DROP TRIGGER hybrid_frame_{name}"
            )))
            .execute(&mut **tx.conn())
            .await
            .unwrap();
        }
        sqlx::raw_sql(sqlx::AssertSqlSafe(triggers()))
            .execute(&mut **tx.conn())
            .await
            .unwrap();
        sqlx::raw_sql("DELETE FROM _hybrid_migrations WHERE version>=4; UPDATE storage_metadata SET maintenance=1; INSERT INTO frames(id,timestamp,full_text,accessibility_tree_json) VALUES(1,'2026-09-14T12:00:00Z','legacy history',printf('%.*c',2097152,'x')),(2,'2026-09-14T12:00:01Z','pending capture',NULL);")
            .execute(&mut **tx.conn()).await.unwrap();
        stage_frames(tx.conn(), 1, 2).await.unwrap();
        sqlx::query(
            "UPDATE storage_metadata SET staging_bytes=(SELECT sum(bytes) FROM frame_payloads)",
        )
        .execute(&mut **tx.conn())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        db.close().await;

        for _ in 0..2 {
            let db = DatabaseManager::new(
                root.path().join("db.sqlite").to_str().unwrap(),
                Default::default(),
            )
            .await
            .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT staging_bytes FROM storage_metadata")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                "pending capture".len() as i64
            );
            assert_eq!(
                db.frame_payloads(&[1], Projection::All).await.unwrap()[&1]
                    .accessibility_tree_json
                    .as_deref(),
                Some("x".repeat(2097152).as_str())
            );
            db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(3,'2026-09-14T12:01:00Z','new capture'); DELETE FROM frames WHERE id=3;").await.unwrap();
            db.close().await;
        }
    }

    #[tokio::test]
    async fn construction_waits_for_finishing_readers_and_rejects_pinned_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("index.sqlite");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .pragma("journal_mode", "WAL")
            .busy_timeout(Duration::from_secs(2));
        let mut writer = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE records(id INTEGER PRIMARY KEY); INSERT INTO records VALUES(1);",
        )
        .execute(&mut writer)
        .await
        .unwrap();
        let mut reader = SqliteConnection::connect_with(&options.read_only(true))
            .await
            .unwrap();
        sqlx::query("BEGIN").execute(&mut reader).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM records")
                .fetch_one(&mut reader)
                .await
                .unwrap(),
            1
        );
        sqlx::query("INSERT INTO records VALUES(2)")
            .execute(&mut writer)
            .await
            .unwrap();

        assert!(construction_checkpoint(&mut writer).await.is_err());
        let (checkpoint, ()) = tokio::join!(construction_checkpoint(&mut writer), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            sqlx::query("ROLLBACK").execute(&mut reader).await.unwrap();
        });
        checkpoint.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM records")
                .fetch_one(&mut reader)
                .await
                .unwrap(),
            2
        );
        reader.close().await.unwrap();
        writer.close().await.unwrap();
    }
}
