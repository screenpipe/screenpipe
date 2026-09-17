// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::storage::{MigrationOptions, PrivacyPolicy, Projection};
use screenpipe_db::DatabaseManager;

async fn number(db: &DatabaseManager, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn blocked_old_element_range_does_not_starve_later_private_work() {
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
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-17','private'); INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(1,1,'accessibility','AXText','first',1),(2,1,'accessibility','AXText','second',1);").await.unwrap();
    assert_eq!(db.seal_payloads().await.unwrap(), 2);
    db.execute_raw_sql_write("UPDATE elements SET text='private again',redacted_at=NULL WHERE id=2; UPDATE elements SET text='safe' WHERE id=1; INSERT INTO elements(id,frame_id,source,role,text,redacted_at) VALUES(3,1,'accessibility','AXText','later safe',1);").await.unwrap();
    assert_eq!(db.seal_payloads().await.unwrap(), 1);
    assert_eq!(
        number(
            &db,
            "SELECT count(*) FROM _bulk_element_rows WHERE id IN (1,2)"
        )
        .await,
        2
    );
    assert_eq!(
        number(&db, "SELECT count(*) FROM _bulk_element_rows WHERE id=3").await,
        0
    );
    assert_eq!(db.seal_payloads().await.unwrap(), 0);
    // The blocked range becomes eligible normally after redaction, without
    // losing either the edits or the independently archived newer record.
    db.execute_raw_sql_write("UPDATE elements SET text='now safe',redacted_at=1 WHERE id=2;")
        .await
        .unwrap();
    assert_eq!(db.seal_payloads().await.unwrap(), 2);
    assert_eq!(number(&db, "SELECT count(*) FROM elements").await, 3);
    assert_eq!(
        number(
            &db,
            "SELECT count(*) FROM elements WHERE text IN ('safe','now safe','later safe')"
        )
        .await,
        3
    );
    assert_eq!(
        number(
            &db,
            "SELECT completed_surfaces FROM frame_payloads WHERE frame_id=1"
        )
        .await
            & 1,
        0
    );
    db.verify_storage().await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn over_budget_redaction_drains_and_restores_capture_without_raising_limit() {
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
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-17','private frame content'); INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(1,'2026-09-17','text','private typed content'); INSERT INTO pipe_executions(id,pipe_name,status,stdout) VALUES(1,'test','running','existing output'); UPDATE storage_metadata SET staging_limit=1;").await.unwrap();
    // A frame that grows still fails atomically, including generation and FTS.
    let mut payload = db
        .frame_payloads(&[1], Projection::All)
        .await
        .unwrap()
        .remove(&1)
        .unwrap();
    let before = number(&db, "SELECT staging_bytes FROM storage_metadata").await;
    let original = payload.clone();
    payload.full_text = Some("x".repeat(100));
    assert!(db
        .replace_frame_payload(&payload, "private", 1, None, None)
        .await
        .is_err());
    assert_eq!(
        number(&db, "SELECT staging_bytes FROM storage_metadata").await,
        before
    );
    assert_eq!(
        db.frame_payloads(&[1], Projection::All).await.unwrap()[&1],
        original
    );
    // Ordinary resident edits can shrink above the cap too, but cannot grow.
    db.execute_raw_sql_write("UPDATE frames SET full_text='safe frame' WHERE id=1")
        .await
        .unwrap();
    assert!(db
        .execute_raw_sql_write("UPDATE frames SET full_text='this payload would grow' WHERE id=1")
        .await
        .is_err());
    let original = db
        .frame_payloads(&[1], Projection::All)
        .await
        .unwrap()
        .remove(&1)
        .unwrap();
    // Unchanged redaction completion can be persisted above the cap.
    assert!(db
        .replace_frame_payload(&original, "private", 1, None, None)
        .await
        .unwrap());
    db.execute_raw_sql_write("UPDATE ui_events SET text_content='safe',redacted_at=1 WHERE id=1; UPDATE pipe_executions SET stdout='done',status='completed',finished_at='2026-09-17' WHERE id=1; INSERT INTO pipe_executions(id,pipe_name,status) VALUES(2,'test','running');").await.unwrap();
    assert!(db
        .execute_raw_sql_write(
            "UPDATE ui_events SET text_content='this would grow the payload' WHERE id=1"
        )
        .await
        .is_err());
    assert!(db.execute_raw_sql_write("INSERT INTO pipe_executions(id,pipe_name,status,stdout) VALUES(3,'test','running','new payload')").await.is_err());
    assert!(db
        .execute_raw_sql_write(
            "INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-09-17','new capture')"
        )
        .await
        .is_err());
    while db.seal_payloads().await.unwrap() != 0 {}
    assert_eq!(
        number(&db, "SELECT staging_bytes FROM storage_metadata").await,
        0
    );
    assert_eq!(
        number(&db, "SELECT staging_limit FROM storage_metadata").await,
        1
    );
    db.execute_raw_sql_write(
        "INSERT INTO frames(id,timestamp,full_text) VALUES(2,'2026-09-17','x')",
    )
    .await
    .unwrap();
    // Restaging archived data consumes new resident bytes, even if the new
    // text is shorter than its archived predecessor.
    assert!(db
        .execute_raw_sql_write("UPDATE ui_events SET text_content='x' WHERE id=1")
        .await
        .is_err());
    assert_eq!(
        number(&db, "SELECT staging_bytes FROM storage_metadata").await,
        1
    );
    db.verify_storage().await.unwrap();
    db.close().await;
    // Startup must leave both the installed fix and accounting unchanged.
    for _ in 0..2 {
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            number(&db, "SELECT staging_bytes FROM storage_metadata").await,
            1
        );
        assert_eq!(
            number(&db, "SELECT staging_limit FROM storage_metadata").await,
            1
        );
        assert_eq!(
            number(
                &db,
                "SELECT count(*) FROM _hybrid_migrations WHERE version=5"
            )
            .await,
            1
        );
        db.close().await;
    }
}

#[tokio::test]
async fn existing_full_generation_upgrades_triggers_once_on_reopen() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-17','old frame'); INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(1,'2026-09-17','text','old text'); UPDATE storage_metadata SET staging_limit=1;").await.unwrap();
    // Restore the shipped absolute guard in a disposable database. Do not
    // merely test new-database bootstrap and assume installed users upgrade.
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    for name in [
        "hybrid_frame_update",
        "hybrid_bulk_ui_events_text_content",
        "hybrid_bulk_pipe_executions_insert",
    ] {
        let sql: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name=?")
            .bind(name)
            .fetch_one(&mut **tx.conn())
            .await
            .unwrap();
        let start = sql.rfind("SELECT CASE WHEN ").unwrap();
        let end = start + sql[start..].find(" THEN RAISE").unwrap();
        let legacy = format!(
            "{}SELECT CASE WHEN (SELECT staging_bytes>staging_limit FROM storage_metadata){}",
            &sql[..start],
            &sql[end..]
        );
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "DROP TRIGGER {name}; {legacy}"
        )))
        .execute(&mut **tx.conn())
        .await
        .unwrap();
    }
    sqlx::query("DELETE FROM _hybrid_migrations WHERE version=5")
        .execute(&mut **tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(db
        .execute_raw_sql_write("UPDATE frames SET full_text='safe' WHERE id=1")
        .await
        .is_err());
    assert!(db
        .execute_raw_sql_write("UPDATE ui_events SET text_content='safe' WHERE id=1")
        .await
        .is_err());
    assert!(db
        .execute_raw_sql_write(
            "INSERT INTO pipe_executions(id,pipe_name,status) VALUES(1,'test','running')"
        )
        .await
        .is_err());
    let before = number(&db, "SELECT staging_bytes FROM storage_metadata").await;
    db.close().await;
    for iteration in 0..2 {
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        if iteration == 0 {
            assert_eq!(
                number(&db, "SELECT staging_bytes FROM storage_metadata").await,
                before
            );
        }
        for query in [
            "UPDATE frames SET full_text='safe' WHERE id=1",
            "UPDATE ui_events SET text_content='safe' WHERE id=1",
            "INSERT OR IGNORE INTO pipe_executions(id,pipe_name,status) VALUES(1,'test','running')",
        ] {
            let mut tx = db.begin_immediate_with_retry().await.unwrap();
            sqlx::query(sqlx::AssertSqlSafe(query))
                .execute(&mut **tx.conn())
                .await
                .unwrap_or_else(|error| panic!("iteration {iteration}, {query}: {error}"));
            tx.commit().await.unwrap();
        }
        assert_eq!(
            number(&db, "SELECT staging_bytes FROM storage_metadata").await,
            8
        );
        assert_eq!(
            number(&db, "SELECT staging_limit FROM storage_metadata").await,
            1
        );
        assert!(db
            .execute_raw_sql_write("UPDATE ui_events SET text_content='this would grow' WHERE id=1")
            .await
            .is_err());
        db.close().await;
    }
}

/// A bounded, opt-in comparison of the old/new guards on the normal write path.
#[tokio::test]
#[ignore = "manual staging guard throughput comparison"]
async fn staging_guard_write_cost() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    db.execute_raw_sql_write("INSERT INTO frames(id,timestamp,full_text) VALUES(1,'2026-09-17','initial'); INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES(1,'2026-09-17','text','initial');").await.unwrap();
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    let mut guards = Vec::new();
    for name in ["hybrid_frame_update", "hybrid_bulk_ui_events_text_content"] {
        let current: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name=?")
            .bind(name)
            .fetch_one(&mut **tx.conn())
            .await
            .unwrap();
        let start = current.rfind("SELECT CASE WHEN ").unwrap();
        let end = start + current[start..].find(" THEN RAISE").unwrap();
        let legacy = format!(
            "{}SELECT CASE WHEN (SELECT staging_bytes>staging_limit FROM storage_metadata){}",
            &current[..start],
            &current[end..]
        );
        guards.push((name, current, legacy));
    }
    tx.commit().await.unwrap();
    let text = "x".repeat(4096);
    for round in 0..6 {
        let current = round % 2 != 0;
        let mut tx = db.begin_immediate_with_retry().await.unwrap();
        for (name, new, old) in &guards {
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "DROP TRIGGER {name}; {}",
                if current { new } else { old }
            )))
            .execute(&mut **tx.conn())
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
        let started = std::time::Instant::now();
        for _ in 0..20 {
            let mut tx = db.begin_immediate_with_retry().await.unwrap();
            // This benchmark swaps DDL between rounds; refresh the selected
            // writer just as startup does after installing the migration.
            sqlx::query("SELECT name FROM main.sqlite_schema LIMIT 1")
                .fetch_optional(&mut **tx.conn())
                .await
                .unwrap();
            for _ in 0..25 {
                sqlx::query("UPDATE frames SET full_text=? WHERE id=1")
                    .bind(&text)
                    .execute(&mut **tx.conn())
                    .await
                    .unwrap();
                sqlx::query("UPDATE ui_events SET text_content=? WHERE id=1")
                    .bind(&text)
                    .execute(&mut **tx.conn())
                    .await
                    .unwrap();
            }
            tx.commit().await.unwrap();
        }
        eprintln!(
            "{}: 1000 writes / 20 commits in {:?}",
            if current { "new" } else { "old" },
            started.elapsed()
        );
    }
    db.close().await;
}
