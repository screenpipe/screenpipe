// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;

#[tokio::test]
async fn background_surfaces_make_independent_history_progress() {
    let root = tempfile::tempdir().unwrap();
    let db = screenpipe_db::DatabaseManager::new(
        root.path().join("db.sqlite").to_str().unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    let worker = Worker::new_with_writer(
        db.pool.clone(),
        db.coordinated_writer(),
        Arc::new(Pipeline::regex_only()),
        WorkerConfig::default(),
    );
    // Interleave surfaces: one global alternating bit would permanently give
    // some tables only newest-first turns when an even number are enabled.
    for id in 1..=5 {
        db.execute_raw_sql_write(&format!(
            "INSERT INTO frames(id,timestamp,full_text) VALUES({id},'2020-01-01','alice@example.com');
             INSERT INTO frames(id,timestamp,accessibility_text) VALUES(1000+{id},'2020-01-01','alice@example.com');
             INSERT INTO ui_events(id,timestamp,event_type,text_content) VALUES({id},'2020-01-01','text','alice@example.com');
             INSERT INTO elements(id,frame_id,source,role,text) VALUES({id},{id},'accessibility','AXTextField','alice@example.com');"
        )).await.unwrap();
        if id > 1 {
            for table in [
                TargetTable::FullText,
                TargetTable::Accessibility,
                TargetTable::UiEvents,
                TargetTable::Elements,
            ] {
                assert_eq!(worker.process_one(table, 1).await.unwrap(), 1);
            }
        }
    }
    for query in [
        "SELECT full_text_redacted_at IS NOT NULL FROM frames WHERE id=1",
        "SELECT accessibility_redacted_at IS NOT NULL FROM frames WHERE id=1001",
        "SELECT redacted_at IS NOT NULL FROM ui_events WHERE id=1",
        "SELECT redacted_at IS NOT NULL FROM elements WHERE id=1",
    ] {
        assert!(
            sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(query))
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            "history starved: {query}"
        );
    }
    db.close().await;
}
