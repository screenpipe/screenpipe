// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Resident table columns used by SQL-to-SQL migration batches.

pub(super) async fn columns(
    source: &sqlx::SqlitePool,
    table: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
        .bind(table)
        .fetch_all(source)
        .await
}
