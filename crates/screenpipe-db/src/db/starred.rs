// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct StarredSession {
    pub id: String,
    pub start: String,
    pub end: String,
    pub hd_requested: bool,
    pub revision: i64,
    /// Recorded audio chunks whose start falls in this interval. Does not
    /// promise that the underlying media has survived retention/deletion.
    pub has_audio: bool,
}

impl DatabaseManager {
    pub async fn list_starred_sessions(
        &self,
        start: &str,
        end: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<StarredSession>, SqlxError> {
        sqlx::query_as("SELECT s.*, EXISTS(SELECT 1 FROM audio_chunks a WHERE a.timestamp >= substr(s.start,1,19) AND a.timestamp < substr(s.end,1,19) || '~' AND julianday(a.timestamp) >= julianday(s.start) AND julianday(a.timestamp) < julianday(s.end) AND a.file_path <> '') AS has_audio FROM starred_sessions s WHERE s.end > ?1 AND s.start < ?2 ORDER BY s.start DESC, s.id LIMIT ?3 OFFSET ?4")
            .bind(start).bind(end).bind(limit.min(100)).bind(offset)
            .fetch_all(&mut *self.acquire_read().await?).await
    }

    /// Merge overlapping intervals before pagination so a capture is returned once.
    /// Return one extra range so callers can reject overly broad work explicitly.
    pub async fn starred_search_ranges(
        &self,
        start: &str,
        end: &str,
    ) -> Result<Vec<(String, String)>, SqlxError> {
        sqlx::query_as(
            "WITH clipped AS (
                SELECT MAX(start, ?1) AS start, MIN(end, ?2) AS end
                FROM starred_sessions WHERE end > ?1 AND start < ?2
            ), preceding AS (
                SELECT *, MAX(end) OVER (ORDER BY start, end ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_end FROM clipped
            ), grouped AS (
                SELECT *, SUM(CASE WHEN previous_end IS NULL OR start > previous_end THEN 1 ELSE 0 END) OVER (ORDER BY start, end) AS island FROM preceding
            ) SELECT MIN(start), MAX(end) FROM grouped GROUP BY island ORDER BY MIN(start) LIMIT 101",
        )
        .bind(start).bind(end)
        .fetch_all(&mut *self.acquire_read().await?).await
    }

    pub async fn get_starred_session(&self, id: &str) -> Result<Option<StarredSession>, SqlxError> {
        sqlx::query_as("SELECT s.*, EXISTS(SELECT 1 FROM audio_chunks a WHERE a.timestamp >= substr(s.start,1,19) AND a.timestamp < substr(s.end,1,19) || '~' AND julianday(a.timestamp) >= julianday(s.start) AND julianday(a.timestamp) < julianday(s.end) AND a.file_path <> '') AS has_audio FROM starred_sessions s WHERE s.id = ?1")
            .bind(id).fetch_optional(&mut *self.acquire_read().await?).await
    }

    /// Revision 0 creates, subsequent writes compare-and-swap. Repeating the
    /// same request after a lost response is idempotent. The shared writer
    /// serializes the overlap check with the write across app windows.
    pub async fn save_starred_session(
        &self,
        id: &str,
        start: &str,
        end: &str,
        hd: bool,
        revision: i64,
        now: &str,
    ) -> Result<bool, SqlxError> {
        let mut tx = self.begin_immediate_with_retry().await?;
        let previous: Option<(String, String, bool, i64)> = sqlx::query_as(
            "SELECT start, end, hd_requested, revision FROM starred_sessions WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&mut **tx.conn())
        .await?;
        if let Some((a, b, h, r)) = &previous {
            if a == start && b == end && *h == hd && (*r == revision || *r == revision + 1) {
                tx.commit().await?;
                return Ok(true);
            }
            if *r != revision {
                return Ok(false);
            }
        } else if revision != 0 {
            return Ok(false);
        }
        if start <= now && end > now {
            let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM starred_sessions WHERE id <> ?1 AND start <= ?2 AND end > ?2)")
                .bind(id).bind(now).fetch_one(&mut **tx.conn()).await?;
            if active {
                return Ok(false);
            }
        }
        sqlx::query("INSERT INTO starred_sessions(id,start,end,hd_requested,revision) VALUES (?1,?2,?3,?4,1) ON CONFLICT(id) DO UPDATE SET start=excluded.start,end=excluded.end,hd_requested=excluded.hd_requested,revision=starred_sessions.revision+1")
            .bind(id).bind(start).bind(end).bind(hd).execute(&mut **tx.conn()).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// One bounded query per search page, never one query per capture/frame.
    pub async fn starred_timestamps(&self, timestamps: &[String]) -> Result<Vec<bool>, SqlxError> {
        let values =
            serde_json::to_string(timestamps).map_err(|e| SqlxError::Protocol(e.to_string()))?;
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM starred_sessions s WHERE s.start <= j.value AND s.end > j.value) FROM json_each(?1) j ORDER BY CAST(j.key AS INTEGER)")
            .bind(values).fetch_all(&mut *self.acquire_read().await?).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn starred_sessions_retry_conflict_expiry_and_search_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new(
            dir.path().join("test.db").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let start = "2026-10-02T10:00:00.000Z";
        let end = "2026-10-02T10:15:00.000Z";
        assert!(db
            .save_starred_session("a", start, end, false, 0, start)
            .await
            .unwrap());
        assert!(db
            .save_starred_session("a", start, end, false, 0, start)
            .await
            .unwrap());
        assert!(!db
            .save_starred_session("b", start, end, false, 0, start)
            .await
            .unwrap());
        assert!(!db
            .save_starred_session("a", start, "2026-10-02T10:30:00.000Z", false, 0, start)
            .await
            .unwrap());
        assert_eq!(
            db.starred_timestamps(&[start.into(), end.into()])
                .await
                .unwrap(),
            vec![true, false]
        );
        assert!(db
            .save_starred_session("b", end, "2026-10-02T10:30:00.000Z", false, 0, end)
            .await
            .unwrap());
        let saved = db.get_starred_session("a").await.unwrap().unwrap();
        assert_eq!(saved.revision, 1);
        assert!(!saved.has_audio);
        db.insert_audio_chunk(
            "test-audio.wav",
            Some(
                DateTime::parse_from_rfc3339(start)
                    .unwrap()
                    .with_timezone(&Utc),
            ),
        )
        .await
        .unwrap();
        assert!(
            db.get_starred_session("a")
                .await
                .unwrap()
                .unwrap()
                .has_audio
        );
        assert_eq!(
            db.list_starred_sessions(start, end, 10, 0)
                .await
                .unwrap()
                .len(),
            1
        );
    }
}
