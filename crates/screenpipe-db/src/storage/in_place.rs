// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! One offline SQLite owner converts resident payloads in the same file. Its
//! committed catalogs, not an external batch journal, own conversion progress.

use super::{bulk, schema, storage_error, HybridStorage, MigrationProgress};
use screenpipe_sqlite_coordinator::SqliteWritePool;
use sqlx::{Connection, Row, SqlitePool};
use std::{fs::OpenOptions, sync::Arc};

// Pool shutdown is asynchronous. Keep the raw fd and manager lease alive even
// if the caller cancels its future while SQLite is finishing a statement.
struct OfflineFile {
    file: Option<std::fs::File>,
    pool: SqlitePool,
    lease: Option<screenpipe_sqlite_coordinator::SqliteManagerLease>,
}

impl Drop for OfflineFile {
    fn drop(&mut self) {
        if self.file.is_none() {
            return;
        }
        let file = self.file.take();
        let lease = self.lease.take();
        let pool = self.pool.clone();
        tokio::spawn(async move {
            pool.close().await;
            drop(file);
            drop(lease);
        });
    }
}

pub(super) fn working_space(budget: &super::StorageBudget) -> u64 {
    budget
        .disk_reserve_bytes
        .saturating_add((budget.file_bytes.max(budget.record_bytes) as u64).saturating_mul(2))
}

pub(super) fn reserve(storage: &HybridStorage) -> Result<(), sqlx::Error> {
    let available = fs2::available_space(&storage.root)?;
    let required = working_space(&storage.descriptor.budget);
    if available < required {
        return Err(storage_error(format!("migration needs {required} free bytes for its next batch and reserve; {available} available. Saved progress will resume after space is available")));
    }
    Ok(())
}

pub(super) async fn convert(
    storage: Arc<HybridStorage>,
    original_allocated: u64,
    total_records: u64,
    progress: &(impl Fn(MigrationProgress) + Send + Sync),
) -> Result<(), sqlx::Error> {
    run(storage, original_allocated, total_records, progress, true).await
}

/// Restore the resident schema and search indexes without encoding payloads,
/// reclaiming files, or completing the migration. Ordinary recording can then
/// use committed Parquet plus resident SQLite until an explicit migration retry.
pub(super) async fn recover_recording(
    storage: Arc<HybridStorage>,
    progress: &(impl Fn(MigrationProgress) + Send + Sync),
) -> Result<(), sqlx::Error> {
    run(storage, 0, 0, progress, false).await
}

async fn run(
    storage: Arc<HybridStorage>,
    original_allocated: u64,
    total_records: u64,
    progress: &(impl Fn(MigrationProgress) + Send + Sync),
    archive: bool,
) -> Result<(), sqlx::Error> {
    let index = storage.root.join(&storage.descriptor.index);
    let lease = screenpipe_sqlite_coordinator::acquire_sqlite_manager_lease(&index)
        .map_err(storage_error)?;
    if !archive {
        progress(MigrationProgress::phase("checking interrupted storage"));
    }
    super::diagnostics::stage("checking_index_before_open");
    crate::recovery::verify_database_before_reopen(&index).await?;
    crate::db::register_sqlite_extensions()?;
    // Do not close this fd while SQLite holds its process-wide Unix locks.
    let file = OpenOptions::new().read(true).write(true).open(&index)?;
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&index)
        .create_if_missing(false)
        .foreign_keys(false)
        .pragma("journal_mode", "WAL")
        .pragma("locking_mode", "EXCLUSIVE")
        .pragma("synchronous", "FULL")
        .pragma("temp_store", "FILE")
        .pragma("secure_delete", "OFF")
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = bulk::pool_options(Some(storage.clone()), false)
        .max_connections(1)
        .min_connections(1)
        .connect_lazy_with(options);
    let mut owner = OfflineFile {
        file: Some(file),
        pool: pool.clone(),
        lease: Some(lease),
    };
    let file = owner.file.as_mut().unwrap();
    let writer = SqliteWritePool::new(
        pool.clone(),
        screenpipe_sqlite_coordinator::sqlite_write_lock(&index),
    );
    let mut reclamation = super::reclaim::Reclaimer::default();
    let mut last_report = None;
    let result = async {
        if archive { reserve(&storage)?; }
        else { progress(MigrationProgress::phase("restoring the recording database")); }
        {
            let permit = writer.lock().await?;
            let mut conn = permit.pool().acquire().await?;
            sqlx::raw_sql("BEGIN EXCLUSIVE; COMMIT; CREATE TABLE IF NOT EXISTS _storage_conversion_steps(step TEXT PRIMARY KEY,last_id INTEGER);").execute(&mut *conn).await?;
            if !schema::converted_step(&mut conn, "original-triggers").await? {
                let mut tx=conn.begin().await?;
                // Preserve the source schema with the index, so provenance also
                // survives compact backups after the outer journal is retired.
                sqlx::raw_sql("CREATE TABLE _storage_conversion_schema(type TEXT NOT NULL,name TEXT NOT NULL,table_name TEXT NOT NULL,sql TEXT); INSERT INTO _storage_conversion_schema SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE '_storage_conversion_%';").execute(&mut *tx).await?;
                sqlx::raw_sql("CREATE TABLE _storage_conversion_triggers(name TEXT PRIMARY KEY,sql TEXT NOT NULL,restore INTEGER NOT NULL DEFAULT 0); INSERT INTO _storage_conversion_triggers(name,sql) SELECT name,sql FROM sqlite_master WHERE type='trigger';").execute(&mut *tx).await?;
                schema::finish_step(&mut tx,"original-triggers").await?;
                tx.commit().await?;
            }
            super::diagnostics::stage("building_migration_schema");
            schema::bootstrap_in_place(&mut conn, &storage.descriptor).await?;
            super::read_schema::upgrade(&mut conn, &storage).await?;
            if !schema::converted_step(&mut conn, "suspend-original-triggers").await? {
                let mut tx=conn.begin().await?;
                let names: Vec<String> = sqlx::query_scalar("SELECT t.name FROM _storage_conversion_triggers t JOIN sqlite_master m ON m.name=t.name AND m.type='trigger' AND m.sql=t.sql").fetch_all(&mut *tx).await?;
                for name in names {
                    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP TRIGGER \"{}\"",name.replace('"',"\"\"")))).execute(&mut *tx).await?;
                    sqlx::query("UPDATE _storage_conversion_triggers SET restore=1 WHERE name=?").bind(name).execute(&mut *tx).await?;
                }
                schema::finish_step(&mut tx,"suspend-original-triggers").await?;
                tx.commit().await?;
            }
            if schema::converted_step(&mut conn,"conversion-complete").await? { return Ok(()); }
            // Compatibility with pre-v6 triggers during interrupted conversion.
            // The v6 startup upgrade removes capture admission limits entirely.
            sqlx::query("UPDATE storage_metadata SET staging_limit=?")
                .bind(if archive { storage.descriptor.budget.staging_bytes as i64 } else { i64::MAX })
                .execute(&mut *conn).await?;
            schema::construction_checkpoint(&mut conn).await?;
        }
        // Encoding reservations left by an interrupted attempt are handled by
        // the existing catalog reclamation; published files are never discarded.
        if archive {
            storage.reclaim_once(&pool, &writer).await?;
            storage.reclaim_bulk(&pool, &writer).await?;
            let reclaimed = reclaim(&storage, &writer, file, &mut reclamation, true).await?;
            report(&storage, &pool, original_allocated, total_records, progress, &mut last_report, reclaimed).await?;
        }
        if !archive { progress(MigrationProgress::phase("restoring saved screen records")); }
        loop {
            if archive { reserve(&storage)?; }
            if archive && storage.seal_once(&pool, &writer).await? != 0 {
                let reclaimed = reclaim(&storage, &writer, file, &mut reclamation, false).await?;
                report(&storage, &pool, original_allocated, total_records, progress, &mut last_report, reclaimed).await?;
                continue;
            }
            super::diagnostics::batch("frames", None, None, None, None);
            super::diagnostics::stage("selecting_resident_frames");
            let last: Option<i64> = sqlx::query_scalar("SELECT max(frame_id) FROM frame_payloads").fetch_one(&pool).await?;
            // Staging is SQL-to-SQL. Only read IDs and lengths here so even a
            // legacy frame larger than the decoder budget stays in SQLite.
            let range = resident_range(&pool, "frames", last, storage.descriptor.budget.file_bytes,
                archive.then_some(storage.descriptor.budget.file_rows)).await?;
            let Some((first, last)) = range else { break };
            super::diagnostics::batch("frames", Some(first), Some(last), None, None);
            super::diagnostics::stage("waiting_for_frame_writer");
            let permit = writer.lock().await?;
            super::diagnostics::stage("waiting_for_frame_connection");
            let mut conn = permit.pool().acquire().await?;
            let mut tx = conn.begin().await?;
            super::diagnostics::stage("staging_frame_payloads");
            schema::stage_frames(&mut tx, first, last).await?;
            tx.commit().await?;
            schema::construction_checkpoint(&mut conn).await?;
            super::faults::checkpoint("migration_batch_staged");
        }
        let source_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='_bulk_elements_source')").fetch_one(&pool).await?;
        if source_exists {
            if !archive { progress(MigrationProgress::phase("restoring saved accessibility records")); }
            let columns = super::import::columns(&pool, "_bulk_elements_source").await?;
            loop {
                if archive { reserve(&storage)?; }
                if archive && bulk::elements::seal(&storage, &pool, &writer).await? != 0 {
                    let reclaimed = reclaim(&storage, &writer, file, &mut reclamation, false).await?;
                    report(&storage, &pool, original_allocated, total_records, progress, &mut last_report, reclaimed).await?;
                    continue;
                }
                // Move existing records inside SQLite, including records larger
                // than any encoder/decoder batch. Sealing can leave them resident.
                let range = resident_range(&pool, "_bulk_elements_source", None,
                    storage.descriptor.budget.file_bytes, archive.then_some(bulk::FILE_ROWS)).await?;
                let Some((first, last)) = range else { break };
                super::diagnostics::batch("elements", Some(first), Some(last), None, None);
                super::diagnostics::stage("waiting_for_element_writer");
                let permit = writer.lock().await?;
                super::diagnostics::stage("waiting_for_element_connection");
                let mut conn = permit.pool().acquire().await?;
                let mut tx = conn.begin().await?;
                super::diagnostics::stage("staging_element_rows");
                let names = columns.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect::<Vec<_>>().join(",");
                sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO _bulk_element_rows({names},_archive_generation) SELECT {names},1 FROM _bulk_elements_source WHERE id BETWEEN ? AND ?")))
                    .bind(first).bind(last).execute(&mut *tx).await?;
                bulk::elements::import_batch(&mut tx, first, last).await?;
                super::diagnostics::stage("deleting_staged_source_elements");
                sqlx::query("DELETE FROM _bulk_elements_source WHERE id BETWEEN ? AND ?").bind(first).bind(last).execute(&mut *tx).await?;
                super::diagnostics::stage("committing_element_staging");
                tx.commit().await?;
                schema::construction_checkpoint(&mut conn).await?;
                super::faults::checkpoint("migration_batch_staged");
                drop(conn);
                drop(permit);
                if archive { reclaim(&storage, &writer, file, &mut reclamation, false).await?; }
            }
            let permit = writer.lock().await?;
            super::diagnostics::stage("dropping_empty_element_source");
            sqlx::query("DROP TABLE _bulk_elements_source").execute(permit.pool()).await?;
        }
        if !archive { progress(MigrationProgress::phase("restoring history search indexes")); }
        for table in bulk::TABLES.iter().filter(|t| t.name != "elements") {
            while archive {
                reserve(&storage)?;
                let rows = storage.select_bulk(&pool, table, None).await?;
                if rows.is_empty() { break; }
                if !table.fts.is_empty() {
                    let ids = serde_json::to_string(&rows.iter().map(|r| r.id).collect::<Vec<_>>()).map_err(storage_error)?;
                    let permit = writer.lock().await?;
                    let mut conn = permit.pool().acquire().await?;
                    let mut tx = conn.begin().await?;
                    for sql in [format!("DELETE FROM {t}_fts WHERE rowid IN (SELECT value FROM json_each(?))",t=table.name), format!("INSERT INTO {t}_fts(rowid,{columns}) SELECT id,{columns} FROM {view} WHERE id IN (SELECT value FROM json_each(?)) AND ({condition})",t=table.name,columns=table.fts_columns(),view=table.view(),condition=table.fts_condition)] {
                        sqlx::query(sqlx::AssertSqlSafe(sql)).bind(&ids).execute(&mut *tx).await?;
                    }
                    tx.commit().await?;
                }
                storage.publish_bulk(&pool, &writer, table, rows, None).await?;
                let reclaimed = reclaim(&storage, &writer, file, &mut reclamation, false).await?;
                report(&storage, &pool, original_allocated, total_records, progress, &mut last_report, reclaimed).await?;
            }
            backfill_resident_fts(&storage, &pool, &writer, table, file, &mut reclamation, archive).await?;
        }
        if !archive { progress(MigrationProgress::phase("finishing recording recovery")); }
        {
            let permit = writer.lock().await?;
            let mut conn = permit.pool().acquire().await?;
            super::diagnostics::stage("building_final_indexes");
            bulk::finish_indexes(&mut conn).await?;
            let mut tx=conn.begin().await?;
            let original: Vec<String> = sqlx::query_scalar("SELECT sql FROM _storage_conversion_triggers WHERE restore=1").fetch_all(&mut *tx).await?;
            for sql in original { sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(&mut *tx).await?; }
            if archive {
                // Preserve the legacy allowance for older schema readers. The
                // current recording triggers do not enforce this as a cap.
                sqlx::query("UPDATE storage_metadata SET staging_limit=staging_bytes+?")
                    .bind(storage.descriptor.budget.staging_bytes as i64)
                    .execute(&mut *tx).await?;
                schema::finish_step(&mut tx,"conversion-complete").await?;
            } else {
                // Restored application triggers must be suspended again only
                // if the user explicitly retries archival later.
                sqlx::query("DELETE FROM _storage_conversion_steps WHERE step='suspend-original-triggers'").execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        if archive {
            reclaim(&storage, &writer, file, &mut reclamation, true).await?;
            super::diagnostics::counts(total_records, total_records);
            progress(MigrationProgress { message: "conversion complete", completed_records: Some(total_records), total_records: Some(total_records),
                bytes_saved: Some(original_allocated.saturating_sub(super::reclaim::footprint(&storage.root)?)), available_bytes: Some(fs2::available_space(&storage.root)?) });
        }
        Ok(())
    }.await;
    if let Err(ref error) = result {
        super::diagnostics::failure(error);
        if let Some(code) = crate::sqlite_error::sqlite_hard_fault_code(error) {
            screenpipe_sqlite_coordinator::latch_sqlite_hard_fault(&index, code);
        }
    }
    super::diagnostics::stage("closing_conversion_pool");
    pool.close().await;
    drop(owner.file.take());
    drop(owner.lease.take());
    result
}

// Only identifiers chosen by the offline runner reach this helper. Recovery
// transfers rows inside SQLite instead of allocating archive-sized Rust values.
async fn resident_range(
    pool: &SqlitePool,
    table: &str,
    after: Option<i64>,
    budget_bytes: usize,
    row_limit: Option<usize>,
) -> Result<Option<(i64, i64)>, sqlx::Error> {
    let lower = after.map_or_else(|| "1".to_owned(), |id| format!("id>{id}"));
    let size = super::import::columns(pool, table).await?.iter().map(|name| {
        let quoted = format!("\"{}\"", name.replace('"', "\"\""));
        format!("CASE WHEN typeof({quoted}) IN ('integer','real') THEN 8 ELSE COALESCE(length(CAST({quoted} AS BLOB)),0) END")
    }).collect::<Vec<_>>().join("+");
    let row_limit = row_limit.unwrap_or(128);
    let rows: Vec<(i64, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id,{size} FROM {table} WHERE {lower} ORDER BY id LIMIT {row_limit}"
    )))
    .fetch_all(pool)
    .await?;
    let mut range = None;
    let mut bytes = 0usize;
    for (id, size) in rows {
        let size = usize::try_from(size).map_err(storage_error)?;
        if range.is_some() && bytes.saturating_add(size) > budget_bytes {
            break;
        }
        bytes = bytes.saturating_add(size);
        range = Some((range.map_or(id, |(first, _)| first), id));
    }
    Ok(range)
}

async fn reclaim(
    storage: &HybridStorage,
    writer: &SqliteWritePool,
    file: &mut std::fs::File,
    reclamation: &mut super::reclaim::Reclaimer,
    force: bool,
) -> Result<bool, sqlx::Error> {
    super::diagnostics::stage("waiting_for_reclamation_writer");
    let permit = writer.lock().await?;
    super::diagnostics::stage("waiting_for_reclamation_connection");
    let mut conn = permit.pool().acquire().await?;
    let reclaimed = reclamation
        .run(
            &mut conn,
            file,
            &storage.root,
            &storage.descriptor.budget,
            force,
        )
        .await?;
    super::faults::checkpoint("migration_batch_sealed");
    Ok(reclaimed)
}

// Privacy-ineligible records remain resident. Their search entries still need
// the same bounded, committed backfill as records that were sealed above.
async fn backfill_resident_fts(
    storage: &HybridStorage,
    pool: &SqlitePool,
    writer: &SqliteWritePool,
    table: &bulk::Table,
    file: &mut std::fs::File,
    reclamation: &mut super::reclaim::Reclaimer,
    archive: bool,
) -> Result<(), sqlx::Error> {
    use futures::TryStreamExt;
    if table.fts.is_empty() {
        return Ok(());
    }
    let step = format!(
        "{}-fts-{}",
        if archive { "resident" } else { "recovery" },
        table.name
    );
    let size = table
        .fts
        .iter()
        .map(|c| {
            format!(
                "COALESCE(length(CAST({} AS BLOB)),0)",
                c.split_whitespace().next().unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join("+");
    loop {
        if archive {
            reserve(storage)?;
        }
        let after: Option<i64> =
            sqlx::query_scalar("SELECT last_id FROM _storage_conversion_steps WHERE step=?")
                .bind(&step)
                .fetch_optional(pool)
                .await?
                .flatten();
        let sql = format!("SELECT id,{size} FROM {t} WHERE _archive_file IS NULL AND id {comparison} ? ORDER BY id LIMIT {rows}",t=table.name,comparison=if after.is_some(){">"}else{">="},rows=bulk::FILE_ROWS);
        let mut stream = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(after.unwrap_or(i64::MIN))
            .fetch(pool);
        let mut ids = Vec::new();
        let mut bytes = 0_usize;
        while let Some(row) = stream.try_next().await? {
            let size = row.get::<i64, _>(1) as usize;
            if !ids.is_empty() && bytes + size > storage.descriptor.budget.file_bytes {
                break;
            }
            ids.push(row.get::<i64, _>(0));
            bytes += size;
        }
        drop(stream);
        let Some(last) = ids.last().copied() else {
            break;
        };
        let ids = serde_json::to_string(&ids).map_err(storage_error)?;
        let permit = writer.lock().await?;
        let mut conn = permit.pool().acquire().await?;
        let mut tx = conn.begin().await?;
        for sql in [format!("DELETE FROM {t}_fts WHERE rowid IN (SELECT value FROM json_each(?))",t=table.name),format!("INSERT INTO {t}_fts(rowid,{columns}) SELECT id,{columns} FROM {t} WHERE id IN (SELECT value FROM json_each(?)) AND ({condition})",t=table.name,columns=table.fts_columns(),condition=table.fts_condition)] {
            sqlx::query(sqlx::AssertSqlSafe(sql)).bind(&ids).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO _storage_conversion_steps(step,last_id) VALUES(?,?) ON CONFLICT(step) DO UPDATE SET last_id=excluded.last_id").bind(&step).bind(last).execute(&mut *tx).await?;
        tx.commit().await?;
        if archive {
            reclamation
                .run(
                    &mut conn,
                    file,
                    &storage.root,
                    &storage.descriptor.budget,
                    false,
                )
                .await?;
        } else {
            schema::construction_checkpoint(&mut conn).await?;
        }
    }
    Ok(())
}

async fn report(
    storage: &HybridStorage,
    pool: &SqlitePool,
    original: u64,
    total: u64,
    progress: &(impl Fn(MigrationProgress) + Send + Sync),
    last_report: &mut Option<std::time::Instant>,
    reclaimed: bool,
) -> Result<(), sqlx::Error> {
    // Measuring savings inventories every archive file. Bound that work by
    // time, and refresh immediately after a physical reclamation pass. The
    // final completion report always measures exact totals.
    if !reclaimed
        && last_report.is_some_and(|last| last.elapsed() < std::time::Duration::from_secs(1))
    {
        return Ok(());
    }
    super::diagnostics::stage("counting_converted_records");
    let frames: i64 =
        sqlx::query_scalar("SELECT count(*) FROM frame_payloads WHERE state='sealed'")
            .fetch_one(pool)
            .await?;
    let bulk: i64 =
        sqlx::query_scalar("SELECT COALESCE(sum(rows),0) FROM _bulk_files WHERE state='published'")
            .fetch_one(pool)
            .await?;
    super::diagnostics::counts((frames + bulk) as u64, total);
    super::diagnostics::stage("measuring_reclaimed_space");
    progress(MigrationProgress {
        message: "converting and freeing disk space",
        completed_records: Some((frames + bulk) as u64),
        total_records: Some(total),
        bytes_saved: Some(original.saturating_sub(super::reclaim::footprint(&storage.root)?)),
        available_bytes: Some(fs2::available_space(&storage.root)?),
    });
    *last_report = Some(std::time::Instant::now());
    Ok(())
}
