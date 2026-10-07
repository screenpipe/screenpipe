// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use screenpipe_db::DatabaseManager;

async fn db(bad: bool) -> DatabaseManager {
    let db = DatabaseManager::new("sqlite::memory:", Default::default()).await.unwrap();
    sqlx::migrate!("./src/migrations").run(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO memories(id,content,source,tags,importance) VALUES (1,'needle both','local','[\"keep\",\"other\"]',0.9),(2,'needle keep','cloud','[\"keep\"]',0.5),(3,'needle other','local','[\"other\"]',0.7)")
        .execute(&db.pool).await.unwrap();
    if bad {
        sqlx::query("INSERT INTO memories(id,content,source,tags) VALUES (4,'needle empty','local',''),(5,'needle null','local',NULL),(6,'needle malformed','local','not json')")
            .execute(&db.pool).await.unwrap();
    }
    db
}
fn tags(values: &[&str]) -> Vec<String> { values.iter().map(|s| s.to_string()).collect() }
async fn ids(db: &DatabaseManager, q: Option<&str>, source: Option<&str>, tags: &[String], limit: u32, offset: u32) -> Vec<i64> {
    let rows = db.list_memories(q,source,None,None,None,None,limit,offset,Some("importance"),Some("desc"),tags).await.expect("memory listing must succeed");
    let mut ids: Vec<i64> = rows.into_iter().map(|row| row.id).collect(); ids.sort(); ids
}
async fn unchanged(db: &DatabaseManager) {
    let stored: Vec<(i64, Option<String>)> = sqlx::query_as("SELECT id,tags FROM memories ORDER BY id").fetch_all(&db.pool).await.unwrap();
    assert_eq!(stored,vec![(1,Some("[\"keep\",\"other\"]".into())),(2,Some("[\"keep\"]".into())),(3,Some("[\"other\"]".into())),(4,Some("".into())),(5,None),(6,Some("not json".into()))]);
}
#[tokio::test]
async fn malformed_rows_do_not_break_listing() {
    let db = db(true).await;
    assert_eq!(ids(&db,None,None,&tags(&["keep"]),50,0).await,vec![1,2]);
    unchanged(&db).await;
}
#[tokio::test]
async fn malformed_rows_do_not_break_counting() {
    let db = db(true).await;
    assert_eq!(db.count_memories(None,None,None,None,None,None,&tags(&["keep"])).await.expect("memory counting must succeed"),2);
    unchanged(&db).await;
}
#[tokio::test]
async fn all_requested_tags_and_absent_tags_are_respected() {
    let db = db(true).await;
    assert_eq!(ids(&db,None,None,&tags(&["keep","other"]),50,0).await,vec![1]);
    assert_eq!(db.count_memories(None,None,None,None,None,None,&tags(&["keep","other"])).await.unwrap(),1);
    assert_eq!(ids(&db,None,None,&tags(&["missing"]),50,0).await,Vec::<i64>::new());
}
#[tokio::test]
async fn unfiltered_reads_preserve_malformed_rows() {
    let db = db(true).await;
    assert_eq!(ids(&db,None,None,&[],50,0).await,vec![1,2,3,4,5,6]);
    assert_eq!(db.count_memories(None,None,None,None,None,None,&[]).await.unwrap(),6);
}
#[tokio::test]
async fn text_search_and_tags_work_together() {
    let db = db(true).await;
    assert_eq!(ids(&db,Some("needle"),None,&tags(&["keep"]),50,0).await,vec![1,2]);
    assert_eq!(db.count_memories(Some("needle"),None,None,None,None,None,&tags(&["keep"])).await.unwrap(),2);
    assert!(ids(&db,Some("unmatched"),None,&tags(&["keep"]),50,0).await.is_empty());
}
#[tokio::test]
async fn valid_rows_keep_filtering_order_and_pagination() {
    let db = db(false).await;
    assert_eq!(ids(&db,None,None,&tags(&["keep"]),1,1).await,vec![2]);
    assert_eq!(ids(&db,None,Some("local"),&tags(&["keep"]),50,0).await,vec![1]);
    assert_eq!(db.count_memories(None,Some("local"),None,Some(0.8),None,None,&tags(&["keep"])).await.unwrap(),1);
    assert_eq!(ids(&db,None,None,&tags(&["keep","other"]),50,0).await,vec![1]);
}
