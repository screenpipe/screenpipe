// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::{names, TABLE};
use crate::{
    storage::{
        bulk::{codec, Kind, Record, Value, FILE_ROWS},
        storage_error, sync_directory, HybridStorage,
    },
    DatabaseManager,
};
use futures::TryStreamExt;
use screenpipe_sqlite_coordinator::SqliteWritePool;
use sqlx::{Connection, Row, SqlitePool, ValueRef};
use std::{collections::BTreeSet, path::Path, sync::Arc};

struct Encoded {
    id: i64,
    first: i64,
    last: i64,
    rows: usize,
    generations: Vec<(i64, i64)>,
}

fn record(row: &sqlx::sqlite::SqliteRow) -> Result<Record, sqlx::Error> {
    let values = TABLE
        .columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            if row.try_get_raw(i + 2)?.is_null() {
                return Ok(Value::Null);
            }
            Ok(match c.kind {
                Kind::Text => Value::Text(row.try_get(i + 2)?),
                Kind::Integer => Value::Integer(row.try_get(i + 2)?),
                Kind::Real => Value::Real(row.try_get(i + 2)?),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    Ok(Record {
        id: row.try_get(0)?,
        generation: row.try_get(1)?,
        values,
    })
}

pub(crate) async fn seal(
    storage: &Arc<HybridStorage>,
    pool: &SqlitePool,
    writer: &SqliteWritePool,
) -> Result<usize, sqlx::Error> {
    Ok(seal_after(storage, pool, writer, None).await?.0)
}

// Only the exclusive offline owner carries a cursor across calls. Live
// recording can edit older rows and therefore always starts a fresh search.
pub(crate) async fn seal_after(
    storage: &Arc<HybridStorage>,
    pool: &SqlitePool,
    writer: &SqliteWritePool,
    mut after: Option<i64>,
) -> Result<(usize, Option<i64>), sqlx::Error> {
    // A dirty archive must be rewritten as a whole. If privacy processing
    // blocks that range, continue after it instead of starving newer work.
    loop {
        crate::storage::diagnostics::batch(
            "elements",
            after.and_then(|id| id.checked_add(1)),
            None,
            None,
            None,
        );
        crate::storage::diagnostics::stage("selecting_staged_elements");
        let lower = after.map_or_else(|| "1".to_owned(), |id| format!("id>{id}"));
        let id: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT id FROM _bulk_element_rows WHERE _archive_deleted=0 AND {lower} AND ({}) ORDER BY id LIMIT 1",
            TABLE.sealable()
        )))
        .fetch_optional(pool)
        .await?;
        let Some(id) = id else { return Ok((0, after)) };
        let range: Option<(i64, i64, i64)> = sqlx::query_as("SELECT first_id,last_id,file_id FROM _bulk_element_ranges WHERE first_id=(SELECT max(first_id) FROM _bulk_element_ranges WHERE first_id<=?1) AND last_id>=?1")
            .bind(id).fetch_optional(pool).await?;
        if let Some((first, last, _)) = range {
            if range_blocked(pool, first, last).await? {
                after = Some(last);
                continue;
            }
        }
        // A concurrent edit invalidating publication is retried next tick,
        // rather than spinning over a stream of newly arriving records.
        return rewrite(storage, pool, writer, id, range).await;
    }
}

async fn range_blocked(pool: &SqlitePool, first: i64, last: i64) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT EXISTS(SELECT 1 FROM elements WHERE id BETWEEN ? AND ? AND NOT ({}))",
        TABLE.sealable()
    )))
    .bind(first)
    .bind(last)
    .fetch_one(pool)
    .await
}

async fn encode(
    storage: &Arc<HybridStorage>,
    writer: &SqliteWritePool,
    rows: Vec<Record>,
) -> Result<Encoded, sqlx::Error> {
    if fs2::available_space(&storage.root)?
        < storage.descriptor.budget.disk_reserve_bytes
            + storage.descriptor.budget.file_bytes as u64 * 2
    {
        return Err(storage_error("element temporary disk reserve reached"));
    }
    let relative = storage
        .descriptor
        .payloads
        .join("bulk-v1/elements")
        .join(format!("{}.parquet", uuid::Uuid::new_v4()));
    let path = storage.payload_path(&relative)?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    crate::storage::diagnostics::batch(
        "elements",
        rows.first().map(|r| r.id),
        rows.last().map(|r| r.id),
        Some(rows.len() as u64),
        Some(rows.iter().map(|r| r.bytes() as u64).sum()),
    );
    crate::storage::diagnostics::stage("reserving_element_archive");
    let id = {
        let permit = writer.lock().await?;
        sqlx::query(
            "INSERT INTO _bulk_files(table_name,path,state,rows) VALUES('elements',?,'encoding',?)",
        )
        .bind(relative.to_string_lossy().as_ref())
        .bind(rows.len() as i64)
        .execute(permit.pool())
        .await?
        .last_insert_rowid()
    };
    crate::storage::faults::checkpoint("bulk_reserved");
    let frames: BTreeSet<_> = rows
        .iter()
        .filter_map(|r| match r.values[0] {
            Value::Integer(id) => Some(id),
            _ => None,
        })
        .collect();
    let output = Encoded {
        id,
        first: rows.first().unwrap().id,
        last: rows.last().unwrap().id,
        rows: rows.len(),
        generations: rows.iter().map(|row| (row.id, row.generation)).collect(),
    };
    let budget = storage.descriptor.budget.clone();
    let file = path.clone();
    crate::storage::diagnostics::stage("waiting_for_element_encoder");
    let decoder = Arc::clone(&storage.decoder)
        .acquire_owned()
        .await
        .map_err(|_| sqlx::Error::PoolClosed)?;
    crate::storage::diagnostics::stage("encoding_and_verifying_elements");
    let hash = tokio::task::spawn_blocking(move || {
        let _decoder = decoder;
        let hash = codec::write(&file, &TABLE, &rows)?;
        if codec::read(&file, &hash, &TABLE, &budget)? != rows {
            return Err(storage_error("element encoded parity mismatch"));
        }
        Ok::<_, sqlx::Error>(hash)
    })
    .await
    .map_err(storage_error)??;
    crate::storage::diagnostics::stage("syncing_element_archive");
    let mut directory = path.parent().unwrap();
    loop {
        sync_directory(directory)?;
        if directory == storage.root {
            break;
        }
        directory = directory
            .parent()
            .ok_or_else(|| storage_error("element parent missing"))?;
    }
    let permit = writer.lock().await?;
    let mut tx = permit.pool().begin().await?;
    sqlx::query("UPDATE _bulk_files SET checksum=? WHERE id=?")
        .bind(hash)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO _bulk_element_frames(frame_id,file_id) SELECT value,? FROM json_each(?)",
    )
    .bind(id)
    .bind(serde_json::to_string(&frames).map_err(storage_error)?)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    crate::storage::faults::checkpoint("bulk_files_synced");
    Ok(output)
}

async fn rewrite(
    storage: &Arc<HybridStorage>,
    pool: &SqlitePool,
    writer: &SqliteWritePool,
    id: i64,
    range: Option<(i64, i64, i64)>,
) -> Result<(usize, Option<i64>), sqlx::Error> {
    let _token = storage.read_token(pool).await?;
    let version: i64 = sqlx::query_scalar("SELECT version FROM _bulk_element_state")
        .fetch_one(pool)
        .await?;
    let policy: (String, i64) =
        sqlx::query_as("SELECT policy,required_surfaces FROM storage_metadata")
            .fetch_one(pool)
            .await?;
    let (first, last) = if let Some((first, last, _)) = range {
        if range_blocked(pool, first, last).await? {
            return Ok((0, None));
        }
        (first, last)
    } else {
        let next: Option<i64> =
            sqlx::query_scalar("SELECT min(first_id) FROM _bulk_element_ranges WHERE first_id>?")
                .bind(id)
                .fetch_one(pool)
                .await?;
        (id, next.map_or(i64::MAX, |n| n - 1))
    };
    // Release each read cursor before encoding takes the writer. Offline
    // migration has one connection; a recovered resident range can exceed one
    // file budget and must not hold that connection while waiting for itself.
    let mut after = None;
    let mut files = Vec::new();
    loop {
        let lower = after.map_or_else(|| "1".to_owned(), |id| format!("id>{id}"));
        // Report the query bounds before awaiting it; actual batch sizes and
        // row IDs are only available once selection returns.
        crate::storage::diagnostics::batch(
            "elements",
            Some(after.map_or(first, |id: i64| id.saturating_add(1))),
            Some(last),
            None,
            None,
        );
        crate::storage::diagnostics::stage("selecting_element_batch");
        // A new range contains only resident rows. Reading its logical virtual
        // table would materialize every private/oversized row while looking
        // for enough eligible records, including a huge recovered backlog.
        let source = if range.is_some() {
            "elements"
        } else {
            "_bulk_element_rows"
        };
        let visible = if range.is_some() {
            "1"
        } else {
            "_archive_deleted=0"
        };
        let candidates: Vec<(i64, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT id,{} FROM {source} WHERE id BETWEEN ? AND ? AND {lower} AND {visible} AND ({}) ORDER BY id LIMIT {FILE_ROWS}",
            TABLE.all_bytes(""), TABLE.eligible
        )))
        .bind(first).bind(last).fetch_all(pool).await?;
        let mut ids = Vec::new();
        let mut bytes = 0usize;
        for (id, size) in candidates {
            let size = usize::try_from(size).map_err(storage_error)?;
            // End the range before a retained record so future rewrites never
            // need to decode that record or remove its SQLite contents.
            if size > storage.descriptor.budget.record_bytes
                || (!ids.is_empty()
                    && bytes.saturating_add(size) > storage.descriptor.budget.file_bytes)
            {
                break;
            }
            ids.push(id);
            bytes += size;
        }
        crate::storage::diagnostics::batch(
            "elements",
            ids.first().copied(),
            ids.last().copied(),
            Some(ids.len() as u64),
            Some(bytes as u64),
        );
        crate::storage::diagnostics::stage("reading_elements_to_seal");
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT id,_archive_generation,{} FROM {source} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id", names()
        )))
        .bind(serde_json::to_string(&ids).map_err(storage_error)?)
        .fetch_all(pool).await?
        .iter().map(record).collect::<Result<Vec<_>, _>>()?;
        let Some(last_row) = rows.last() else { break };
        after = Some(last_row.id);
        files.push(encode(storage, writer, rows).await?);
        if range.is_none() {
            break;
        }
    }
    let last = if range.is_some() {
        last
    } else if let Some(file) = files.last() {
        file.last
    } else {
        return Ok((0, None));
    };
    crate::storage::diagnostics::stage("publishing_element_archive");
    #[cfg(test)]
    {
        let hook = storage.bulk.element_publish_hook.lock().unwrap().clone();
        if let Some(hook) = hook {
            tokio::task::spawn_blocking(move || hook()).await.unwrap();
        }
    }
    let permit = writer.lock().await?;
    let mut tx = permit.pool().begin().await?;
    let current: i64 = sqlx::query_scalar("SELECT version FROM _bulk_element_state")
        .fetch_one(&mut *tx)
        .await?;
    let current_policy: (String, i64) =
        sqlx::query_as("SELECT policy,required_surfaces FROM storage_metadata")
            .fetch_one(&mut *tx)
            .await?;
    // New captures change the table-wide version while this batch encodes.
    // Only mutations inside the range being published can invalidate it.
    // Retain the O(1) check when nothing changed; otherwise compare resident
    // generations, including tombstones and newly eligible gap inserts.
    let valid = current_policy == policy
        && (current == version
            || resident_range_unchanged(&mut tx, first, last, &files, range.is_some()).await?);
    if !valid {
        for file in files {
            sqlx::query("UPDATE _bulk_files SET state='retired' WHERE id=?")
                .bind(file.id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        return Ok((0, None));
    }
    let selection = if range.is_some() {
        "1".into()
    } else {
        format!("_archive_deleted=1 OR ({})", TABLE.sealable())
    };
    let freed:i64=sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COALESCE(SUM({}),0) FROM _bulk_element_rows WHERE id BETWEEN ? AND ? AND ({selection})",TABLE.all_bytes("")))).bind(first).bind(last).fetch_one(&mut *tx).await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DELETE FROM _bulk_element_rows WHERE id BETWEEN ? AND ? AND ({selection})"
    )))
    .bind(first)
    .bind(last)
    .execute(&mut *tx)
    .await?;
    if let Some((_, _, old)) = range {
        sqlx::query("DELETE FROM _bulk_element_ranges WHERE file_id=?")
            .bind(old)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE _bulk_files SET state='retired' WHERE id=?")
            .bind(old)
            .execute(&mut *tx)
            .await?;
    }
    for file in &files {
        sqlx::query("INSERT INTO _bulk_element_ranges VALUES(?,?,?)")
            .bind(file.first)
            .bind(file.last)
            .bind(file.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE _bulk_files SET state='published' WHERE id=?")
            .bind(file.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE _bulk_element_rows SET _archive_file=? WHERE id BETWEEN ? AND ?")
            .bind(file.id)
            .bind(file.first)
            .bind(file.last)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE storage_metadata SET staging_bytes=staging_bytes-?")
        .bind(freed)
        .execute(&mut *tx)
        .await?;
    crate::storage::faults::checkpoint("bulk_before_commit");
    crate::storage::diagnostics::stage("committing_element_archive");
    tx.commit().await?;
    crate::storage::faults::checkpoint("bulk_committed");
    let count = files.iter().map(|f| f.rows).sum();
    tracing::info!(rows = count, files = files.len(), "sealed element records");
    Ok((count, Some(last)))
}

async fn resident_range_unchanged(
    conn: &mut sqlx::SqliteConnection,
    first: i64,
    last: i64,
    files: &[Encoded],
    whole_range: bool,
) -> Result<bool, sqlx::Error> {
    let mut rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT id,_archive_generation,_archive_deleted,({}) AS sealable FROM _bulk_element_rows WHERE id BETWEEN ? AND ? ORDER BY id",
        TABLE.sealable()
    )))
    .bind(first).bind(last).fetch(&mut *conn);
    while let Some(row) = rows.try_next().await? {
        let id: i64 = row.try_get("id")?;
        let generation: i64 = row.try_get("_archive_generation")?;
        let deleted: bool = row.try_get("_archive_deleted")?;
        let sealable: bool = row.try_get("sealable")?;
        let file = files.partition_point(|file| file.last < id);
        let encoded = files.get(file).and_then(|file| {
            file.generations
                .binary_search_by_key(&id, |(id, _)| *id)
                .ok()
                .map(|index| file.generations[index].1)
        });
        match encoded {
            Some(expected) if deleted || !sealable || generation != expected => return Ok(false),
            // A newly eligible record in a gap must not be deleted without
            // being encoded. Unchanged private gaps and old tombstones stay
            // governed by the existing publication selection.
            None if !deleted && (whole_range || sealable) => return Ok(false),
            _ => {}
        }
    }
    Ok(true)
}

pub(crate) async fn reclaim(
    storage: &Arc<HybridStorage>,
    pool: &SqlitePool,
    writer: &SqliteWritePool,
) -> Result<(), sqlx::Error> {
    let range:Option<(i64,i64,i64)>=sqlx::query_as("SELECT r.first_id,r.last_id,r.file_id FROM _bulk_element_ranges r JOIN _bulk_files p ON p.id=r.file_id WHERE p.state='dirty' ORDER BY r.first_id LIMIT 1").fetch_optional(pool).await?;
    if let Some(range) = range {
        rewrite(storage, pool, writer, range.0, Some(range)).await?;
    }
    let permit = writer.lock().await?;
    sqlx::query(
        "DELETE FROM _bulk_element_rows WHERE _archive_deleted=1 AND _archive_file IS NULL",
    )
    .execute(permit.pool())
    .await?;
    sqlx::query(
        "UPDATE _bulk_files SET state='retired' WHERE table_name='elements' AND state='encoding'",
    )
    .execute(permit.pool())
    .await?;
    sqlx::query("DELETE FROM _bulk_element_frames WHERE file_id IN (SELECT id FROM _bulk_files WHERE state='retired')").execute(permit.pool()).await?;
    Ok(())
}

// Compute the preceding maximum once in primary-key order. A correlated MAX
// rescans the entire prefix for every file, making large catalogs quadratic.
// Keep the maximum (rather than only the preceding row) so even malformed or
// missing-file ranges retain exactly the same overlap checks.
const INVALID_RANGES: &str = "WITH ranges AS (
    SELECT first_id,last_id,file_id,
           max(last_id) OVER (ORDER BY first_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_last
    FROM _bulk_element_ranges
) SELECT EXISTS(
    SELECT 1 FROM ranges r JOIN _bulk_files p ON p.id=r.file_id
    WHERE r.first_id>r.last_id OR p.table_name!='elements'
       OR p.state NOT IN ('published','dirty')
       OR r.first_id<=r.previous_last
)";

pub(crate) async fn verify(
    storage: &Arc<HybridStorage>,
    pool: &SqlitePool,
) -> Result<(), sqlx::Error> {
    let bad: bool = sqlx::query_scalar(INVALID_RANGES).fetch_one(pool).await?;
    if bad {
        return Err(storage_error("element range catalog is invalid"));
    }
    let files:Vec<(i64,i64,i64,String,String)>=sqlx::query_as("SELECT r.file_id,r.first_id,r.last_id,p.path,p.checksum FROM _bulk_element_ranges r JOIN _bulk_files p ON p.id=r.file_id ORDER BY r.first_id").fetch_all(pool).await?;
    for (id, first, last, path, hash) in files {
        let storage = storage.clone();
        let rows = tokio::task::spawn_blocking(move || {
            codec::read(
                &storage.payload_path(Path::new(&path))?,
                &hash,
                &TABLE,
                &storage.descriptor.budget,
            )
        })
        .await
        .map_err(storage_error)??;
        if rows.first().map(|r| r.id) != Some(first) || rows.last().map(|r| r.id) != Some(last) {
            return Err(storage_error("element range identity mismatch"));
        }
        let expected: BTreeSet<_> = rows
            .iter()
            .filter_map(|r| match r.values[0] {
                Value::Integer(id) => Some(id),
                _ => None,
            })
            .collect();
        let actual: BTreeSet<i64> =
            sqlx::query_scalar("SELECT frame_id FROM _bulk_element_frames WHERE file_id=?")
                .bind(id)
                .fetch_all(pool)
                .await?
                .into_iter()
                .collect();
        if actual != expected {
            return Err(storage_error("element frame catalog mismatch"));
        }
    }
    // Aggregate verification spills to a temporary file. This checked-out
    // connection closes afterward, including cancellation, so its temporary
    // query settings never return to the live pool.
    let mut validation = pool.acquire().await?;
    validation.close_on_drop();
    sqlx::query("PRAGMA temp_store=FILE")
        .execute(&mut *validation)
        .await?;
    for (column, table) in [("parent_id", "_bulk_element_parent_refs")] {
        let bad:bool=sqlx::query_scalar(sqlx::AssertSqlSafe(format!("WITH actual AS (SELECT {column},count(*) AS rows FROM elements WHERE {column} IS NOT NULL GROUP BY {column}), difference AS (SELECT * FROM actual EXCEPT SELECT * FROM {table}), reverse_difference AS (SELECT * FROM {table} EXCEPT SELECT * FROM actual) SELECT EXISTS(SELECT 1 FROM difference UNION ALL SELECT 1 FROM reverse_difference)"))).fetch_one(&mut *validation).await?;
        if bad {
            return Err(storage_error("element relationship counts differ"));
        }
    }
    let groups: bool = sqlx::query_scalar("WITH actual AS (SELECT frame_id,source,role,COALESCE(on_screen,0) AS visibility,on_screen IS NULL AS is_null,count(*) AS rows FROM elements GROUP BY frame_id,source,role,COALESCE(on_screen,0),on_screen IS NULL), expected AS (SELECT g.frame_id,k.source,k.role,g.visibility,g.is_null,g.rows FROM _bulk_element_groups g JOIN _bulk_element_kinds k ON k.id=g.kind_id), difference AS (SELECT * FROM actual EXCEPT SELECT * FROM expected), reverse_difference AS (SELECT * FROM expected EXCEPT SELECT * FROM actual) SELECT EXISTS(SELECT 1 FROM difference UNION ALL SELECT 1 FROM reverse_difference)").fetch_one(&mut *validation).await?;
    if groups {
        return Err(storage_error("element summary counts differ"));
    }
    // Count every preserved parent reference, including dangling legacy ones.
    // Requiring those parents to exist would reintroduce the migration gate
    // intentionally excluded by lifecycle::verify_integrity. New element
    // writes still validate their affected relationships in Elements::sync.
    Ok(())
}

pub(crate) async fn export(
    source: &DatabaseManager,
    output: &mut sqlx::SqliteConnection,
) -> Result<(), sqlx::Error> {
    super::register(output, source.storage.as_ref().unwrap().clone()).await?;
    let sql: String = sqlx::query_scalar("SELECT sql FROM _bulk_legacy_sql WHERE name='elements'")
        .fetch_one(&mut *output)
        .await?;
    sqlx::raw_sql(
        "DROP VIEW _bulk_logical_elements; DROP VIEW _bulk_element_search_content; DROP TABLE elements; DROP TABLE elements_fts;",
    )
    .execute(&mut *output)
    .await?;
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(&mut *output)
        .await?;
    // Only the unpublished export copy suspends FK checks while rows are
    // restored in ID order. Full verification precedes its publication.
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&mut *output)
        .await?;
    let mut stream = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT id,_archive_generation,{} FROM elements ORDER BY id",
        names()
    )))
    .fetch(&source.pool);
    let mut batch = Vec::new();
    let mut bytes = 0;
    while let Some(row) = stream.try_next().await? {
        let row = record(&row)?;
        if !batch.is_empty()
            && (batch.len() == 128
                || bytes + row.bytes()
                    > source
                        .storage
                        .as_ref()
                        .unwrap()
                        .descriptor
                        .budget
                        .file_bytes)
        {
            export_batch(output, std::mem::take(&mut batch)).await?;
            bytes = 0;
        }
        bytes += row.bytes();
        batch.push(row);
    }
    drop(stream);
    if !batch.is_empty() {
        export_batch(output, batch).await?;
    }
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut *output)
        .await?;
    sqlx::raw_sql("DROP TABLE _bulk_element_rows; DROP TABLE _bulk_element_ranges; DROP TABLE _bulk_element_frames; DROP VIEW _bulk_element_counts; DROP TABLE _bulk_element_groups; DROP TABLE _bulk_element_parent_refs; DROP TABLE _bulk_element_checks; DROP TABLE _bulk_element_state; DROP TABLE _bulk_element_kinds;").execute(&mut *output).await?;
    Ok(())
}

async fn export_batch(
    output: &mut sqlx::SqliteConnection,
    rows: Vec<Record>,
) -> Result<(), sqlx::Error> {
    let mut tx = output.begin().await?;
    for row in rows {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
            "INSERT INTO elements(id,{}) VALUES({})",
            names(),
            vec!["?"; TABLE.columns.len() + 1].join(",")
        )))
        .bind(row.id);
        for value in row.values {
            query = match value {
                Value::Null => query.bind(Option::<String>::None),
                Value::Integer(v) => query.bind(v),
                Value::Real(v) => query.bind(v),
                Value::Text(v) => query.bind(v),
            };
        }
        query.execute(&mut *tx).await?;
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::INVALID_RANGES;
    use rusqlite::{Connection, StatementStatus};

    fn catalog(ranges: &[(i64, i64)]) -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE _bulk_files(id INTEGER PRIMARY KEY,table_name TEXT,state TEXT);
            CREATE TABLE _bulk_element_ranges(first_id INTEGER PRIMARY KEY,last_id INTEGER NOT NULL,
                file_id INTEGER NOT NULL UNIQUE REFERENCES _bulk_files(id));",
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        for (id, &(first, last)) in ranges.iter().enumerate() {
            tx.execute(
                "INSERT INTO _bulk_files VALUES(?,'elements','published')",
                [id as i64],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO _bulk_element_ranges VALUES(?,?,?)",
                [first, last, id as i64],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        db
    }

    #[test]
    fn range_catalog_rejects_overlaps_and_invalid_publications() {
        for (ranges, invalid) in [
            (vec![], false),
            (vec![(i64::MIN, -1), (0, 0), (1, i64::MAX)], false),
            (vec![(20, 30), (0, 10)], false),
            (vec![(0, 10), (10, 20)], true),
            (vec![(0, 100), (10, 20), (30, 40)], true),
            (vec![(0, 10), (11, 9)], true),
        ] {
            let db = catalog(&ranges);
            assert_eq!(
                db.query_row(INVALID_RANGES, [], |r| r.get::<_, bool>(0))
                    .unwrap(),
                invalid,
                "{ranges:?}"
            );
        }
        for (table, state, invalid) in [
            ("elements", "published", false),
            ("elements", "dirty", false),
            ("elements", "encoding", true),
            ("elements", "retired", true),
            ("outputs", "published", true),
        ] {
            let db = catalog(&[(1, 2)]);
            db.execute(
                "UPDATE _bulk_files SET table_name=?,state=?",
                [table, state],
            )
            .unwrap();
            assert_eq!(
                db.query_row(INVALID_RANGES, [], |r| r.get::<_, bool>(0))
                    .unwrap(),
                invalid,
                "{table} {state}"
            );
        }
        // Even if earlier ranges have lost their catalog entries, their
        // largest end still participates in the original overlap check.
        let db = catalog(&[(0, 100), (10, 20), (30, 40)]);
        db.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        db.execute("DELETE FROM _bulk_files WHERE id<2", [])
            .unwrap();
        assert!(db
            .query_row(INVALID_RANGES, [], |r| r.get::<_, bool>(0))
            .unwrap());
    }

    #[test]
    fn range_catalog_work_scales_with_archive_count() {
        let mut previous = 0;
        for count in [1_000, 2_000, 4_000] {
            let db = catalog(
                &(0..count)
                    .map(|i| (i * 32_768, (i + 1) * 32_768 - 1))
                    .collect::<Vec<_>>(),
            );
            let mut statement = db.prepare(INVALID_RANGES).unwrap();
            let started = std::time::Instant::now();
            assert!(!statement.query_row([], |r| r.get::<_, bool>(0)).unwrap());
            let steps = statement.get_status(StatementStatus::VmStep);
            eprintln!(
                "range catalog: files={count} steps={steps} elapsed={:?}",
                started.elapsed()
            );
            // Instruction counts prove the absence of repeated prefix scans
            // without a timing assertion sensitive to concurrent builds.
            if previous != 0 {
                assert!(
                    steps < previous * 3,
                    "doubling files must not quadruple verification work"
                );
            }
            previous = steps;
        }
    }
}
