// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::{DatabaseManager, SqlxError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FocusedPhase {
    Recording,
    Paused,
    Summary,
    Submitted,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocusedInterval {
    pub start: i64,
    pub end: Option<i64>,
    #[serde(default)]
    pub audio_grace_until: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusedMedia {
    pub screen_frames: i64,
    pub audio_seconds: f64,
    pub audio_chunks: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusedRecording {
    pub id: String,
    pub name: String,
    pub phase: FocusedPhase,
    pub voice_enabled: bool,
    pub created_at: i64,
    pub revision: i64,
    #[serde(default)]
    pub last_capture_at: i64,
    #[serde(default)]
    pub capture_until: i64,
    #[serde(default)]
    pub capture_owner: Option<String>,
    pub intervals: Vec<FocusedInterval>,
    pub media: Option<FocusedMedia>,
    #[serde(default)]
    pub last_request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum FocusedAction {
    Rename { name: String },
    Pause,
    Resume,
    Heartbeat,
    Finish,
    Submit,
    Delete { confirmed: bool },
    Voice { enabled: bool },
}

impl FocusedRecording {
    pub fn new(id: String, now: i64, voice_enabled: bool) -> Self {
        Self {
            id,
            name: String::new(),
            phase: FocusedPhase::Recording,
            voice_enabled,
            created_at: now,
            revision: 0,
            last_capture_at: now,
            capture_until: now + 15_000,
            capture_owner: None,
            intervals: vec![FocusedInterval {
                start: now,
                end: None,
                audio_grace_until: None,
            }],
            media: None,
            last_request_id: None,
        }
    }
    pub fn pause_interrupted(&mut self, until: i64) -> Result<(), &'static str> {
        if self.phase == FocusedPhase::Recording {
            if let Some(interval) = self.intervals.last_mut() {
                interval.audio_grace_until = Some(self.capture_until);
            }
        }
        self.apply(FocusedAction::Pause, until)
    }
    pub fn elapsed_ms(&self, now: i64) -> i64 {
        self.intervals
            .iter()
            .map(|i| i.end.unwrap_or(now).saturating_sub(i.start).max(0))
            .sum()
    }
    pub fn apply(&mut self, action: FocusedAction, now: i64) -> Result<(), &'static str> {
        use FocusedAction::*;
        use FocusedPhase as Phase;
        if matches!(self.phase, Phase::Submitted | Phase::Deleted) {
            return Err("This recording is already complete.");
        }
        match action {
            Rename { name } => {
                if name.chars().count() > 200 {
                    return Err("Use a workflow name of 200 characters or fewer.");
                }
                self.name = name;
            }
            Voice { enabled } => {
                self.voice_enabled = enabled;
            }
            Pause if self.phase == Phase::Recording => {
                self.close_interval(now);
                self.phase = Phase::Paused;
            }
            Pause if self.phase == Phase::Paused => {}
            Heartbeat if self.phase == Phase::Recording => {
                self.last_capture_at = now;
                self.capture_until = now + 15_000;
            }
            Resume if self.phase == Phase::Recording => {}
            Resume => {
                self.intervals.push(FocusedInterval {
                    start: now,
                    end: None,
                    audio_grace_until: None,
                });
                self.phase = Phase::Recording;
                self.last_capture_at = now;
                self.capture_until = now + 15_000;
                self.media = None;
            }
            Finish => {
                self.close_interval(now);
                self.phase = Phase::Summary;
            }
            Submit if self.phase == Phase::Summary && !self.name.trim().is_empty() => {
                self.name = self.name.trim().to_owned();
                self.phase = Phase::Submitted;
            }
            Delete { confirmed: true } if self.phase == Phase::Summary => {
                self.phase = Phase::Deleted;
                self.name.clear();
                self.intervals.clear();
                self.media = None;
                self.voice_enabled = false;
            }
            _ => return Err("This action is unavailable. Reload the recording and try again."),
        }
        Ok(())
    }
    fn close_interval(&mut self, now: i64) {
        if let Some(interval) = self.intervals.last_mut().filter(|i| i.end.is_none()) {
            interval.end = Some(now.max(interval.start));
        }
    }
}

fn protocol(error: impl std::fmt::Display) -> SqlxError {
    SqlxError::Protocol(error.to_string())
}

impl DatabaseManager {
    pub async fn focused_voice_preference(&self) -> Result<Option<bool>, SqlxError> {
        sqlx::query_scalar(
            "SELECT voice_enabled FROM focused_recording_preferences WHERE singleton=1",
        )
        .fetch_optional(&mut *self.acquire_read().await?)
        .await
    }

    pub async fn focused_audio_end(&self, id: &str) -> Result<Option<i64>, SqlxError> {
        sqlx::query_scalar("SELECT MAX(end_ms) FROM focused_recording_audio WHERE recording_id=?1")
            .bind(id)
            .fetch_one(&mut *self.acquire_read().await?)
            .await
    }
    pub async fn current_focused_recording(&self) -> Result<Option<FocusedRecording>, SqlxError> {
        let body: Option<String> = sqlx::query_scalar("SELECT body FROM focused_recordings WHERE current_slot=1 AND phase <> 'deleted' ORDER BY CASE WHEN phase IN ('recording','paused','summary') THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1")
            .fetch_optional(&mut *self.acquire_read().await?).await?;
        body.map(|body| serde_json::from_str(&body).map_err(protocol))
            .transpose()
    }
    pub async fn get_focused_recording(
        &self,
        id: &str,
    ) -> Result<Option<FocusedRecording>, SqlxError> {
        let body: Option<String> =
            sqlx::query_scalar("SELECT body FROM focused_recordings WHERE id = ?1")
                .bind(id)
                .fetch_optional(&mut *self.acquire_read().await?)
                .await?;
        body.map(|body| serde_json::from_str(&body).map_err(protocol))
            .transpose()
    }
    /// Captured files, not OCR/transcription rows, determine track availability.
    /// The interval predicate excludes pauses and deduplicates resumed ranges.
    pub async fn focused_recording_media(
        &self,
        session: &FocusedRecording,
    ) -> Result<FocusedMedia, SqlxError> {
        let intervals = serde_json::to_string(&session.intervals).map_err(protocol)?;
        let bounds = session
            .intervals
            .iter()
            .map(|i| i.start)
            .min()
            .zip(session.intervals.iter().filter_map(|i| i.end).max());
        let frames = if let Some((first, last)) = bounds {
            let lower = chrono::DateTime::from_timestamp_millis(first)
                .ok_or_else(|| protocol("Invalid capture start"))?
                .format("%Y-%m-%d")
                .to_string();
            let upper = chrono::DateTime::from_timestamp_millis(last)
                .and_then(|t| t.date_naive().succ_opt())
                .ok_or_else(|| protocol("Invalid capture end"))?
                .to_string();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM frames f LEFT JOIN video_chunks v ON v.id=f.video_chunk_id WHERE f.timestamp >= ?2 AND f.timestamp < ?3 AND (COALESCE(f.snapshot_path,'') <> '' OR COALESCE(v.file_path,'') <> '') AND EXISTS (SELECT 1 FROM json_each(?1) i WHERE julianday(f.timestamp) >= julianday(json_extract(i.value,'$.start')/1000.0,'unixepoch') AND julianday(f.timestamp) < julianday(json_extract(i.value,'$.end')/1000.0,'unixepoch'))")
            .bind(intervals).bind(lower).bind(upper).fetch_one(&mut *self.acquire_read().await?).await?;
            count
        } else {
            0
        };
        let (chunks, milliseconds): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(end_ms-start_ms),0) FROM focused_recording_audio WHERE recording_id=?1")
            .bind(&session.id).fetch_one(&mut *self.acquire_read().await?).await?;
        Ok(FocusedMedia {
            screen_frames: frames,
            audio_seconds: milliseconds as f64 / 1000.0,
            audio_chunks: chunks,
        })
    }

    pub async fn save_focused_audio(
        &self,
        recording_id: &str,
        chunk_id: &str,
        stream_id: &str,
        sequence: i64,
        start: i64,
        end: i64,
        mime: &str,
        bytes: &[u8],
    ) -> Result<bool, SqlxError> {
        let mut tx = self.begin_immediate_with_retry().await?;
        let body: Option<String> =
            sqlx::query_scalar("SELECT body FROM focused_recordings WHERE id=?1")
                .bind(recording_id)
                .fetch_optional(&mut **tx.conn())
                .await?;
        let Some(body) = body else {
            return Ok(false);
        };
        let mut session: FocusedRecording = serde_json::from_str(&body).map_err(protocol)?;
        if matches!(
            session.phase,
            FocusedPhase::Submitted | FocusedPhase::Deleted | FocusedPhase::Summary
        ) || bytes.is_empty()
            || end < start
            || sequence < 0
        {
            return Ok(false);
        }
        let previous: Option<(String, i64, i64, i64, String, Vec<u8>)> = sqlx::query_as("SELECT stream_id,sequence,start_ms,end_ms,mime,audio FROM focused_recording_audio WHERE id=?1 AND recording_id=?2")
            .bind(chunk_id).bind(recording_id).fetch_optional(&mut **tx.conn()).await?;
        if let Some(previous) = previous {
            return Ok(previous
                == (
                    stream_id.to_owned(),
                    sequence,
                    start,
                    end,
                    mime.to_owned(),
                    bytes.to_vec(),
                ));
        }
        let last: Option<(i64,i64,i64)> = sqlx::query_as("SELECT MAX(sequence),MAX(end_ms),MIN(start_ms) FROM focused_recording_audio WHERE recording_id=?1 AND stream_id=?2 GROUP BY stream_id")
            .bind(recording_id).bind(stream_id).fetch_optional(&mut **tx.conn()).await?;
        if match last {
            Some((index, until, _)) => sequence != index + 1 || start != until,
            None => sequence != 0,
        } {
            return Ok(false);
        }
        let began = last.map_or(start, |(_, _, first)| first);
        let normal = session
            .intervals
            .iter()
            .position(|i| began >= i.start && i.end.is_none_or(|until| began <= until));
        let target = normal.or_else(|| {
            session.intervals.iter().position(|i| {
                began >= i.start && i.audio_grace_until.is_some_and(|until| began <= until)
            })
        });
        let Some(index) = target else {
            return Ok(false);
        };
        if let Some(until) = session.intervals[index].end {
            if end > until {
                if session.intervals[index].audio_grace_until.is_none() {
                    return Ok(false);
                }
                let end = end.min(session.intervals.get(index + 1).map_or(end, |i| i.start));
                if end > until {
                    session.intervals[index].end = Some(end);
                    session.revision += 1;
                    let body = serde_json::to_string(&session).map_err(protocol)?;
                    sqlx::query("UPDATE focused_recordings SET body=?2,revision=?3 WHERE id=?1")
                        .bind(recording_id)
                        .bind(body)
                        .bind(session.revision)
                        .execute(&mut **tx.conn())
                        .await?;
                }
            }
        }
        sqlx::query("INSERT INTO focused_recording_audio(id,recording_id,stream_id,sequence,start_ms,end_ms,mime,audio) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
            .bind(chunk_id).bind(recording_id).bind(stream_id).bind(sequence).bind(start).bind(end).bind(mime).bind(bytes)
            .execute(&mut **tx.conn()).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Uses the same serialized writer as captured data. A repeated response-lost
    /// write is safe; a different write based on a stale revision is rejected.
    pub async fn save_focused_recording(
        &self,
        value: &mut FocusedRecording,
        expected: i64,
    ) -> Result<bool, SqlxError> {
        self.save_focused_recording_slot(value, expected, true)
            .await
    }
    /// Retire only the active slot. Workflow content and audio remain intact.
    pub async fn retire_focused_recording(
        &self,
        value: &mut FocusedRecording,
        expected: i64,
    ) -> Result<bool, SqlxError> {
        self.save_focused_recording_slot(value, expected, false)
            .await
    }
    async fn save_focused_recording_slot(
        &self,
        value: &mut FocusedRecording,
        expected: i64,
        current_slot: bool,
    ) -> Result<bool, SqlxError> {
        let mut next = value.clone();
        next.revision = expected
            .checked_add(1)
            .ok_or_else(|| protocol("Invalid recording revision"))?;
        let body = serde_json::to_string(&next).map_err(protocol)?;
        let phase = serde_json::to_value(next.phase)
            .map_err(protocol)?
            .as_str()
            .unwrap()
            .to_owned();
        let mut tx = self.begin_immediate_with_retry().await?;
        let previous: Option<(i64, String)> =
            sqlx::query_as("SELECT revision, body FROM focused_recordings WHERE id = ?1")
                .bind(&next.id)
                .fetch_optional(&mut **tx.conn())
                .await?;
        if let Some((revision, old_body)) = previous {
            if revision == next.revision && old_body == body {
                tx.commit().await?;
                *value = next;
                return Ok(true);
            }
            if revision != expected {
                return Ok(false);
            }
        } else if expected != 0 {
            return Ok(false);
        }
        sqlx::query("INSERT INTO focused_recordings(id,phase,created_at,revision,body,current_slot) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,revision=excluded.revision,body=excluded.body,current_slot=excluded.current_slot")
            .bind(&next.id).bind(phase).bind(next.created_at).bind(next.revision).bind(body).bind(current_slot)
            .execute(&mut **tx.conn()).await?;
        // Local Save is an atomic handoff to the incumbent starred path.
        // Preserve each pause/resume interval; never star the bounding envelope.
        if next.phase == FocusedPhase::Submitted {
            for interval in &next.intervals {
                let Some(end) = interval.end.filter(|end| *end > interval.start) else {
                    continue;
                };
                let stamp = |ms| {
                    chrono::DateTime::from_timestamp_millis(ms)
                        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                        .ok_or_else(|| protocol("Invalid capture interval"))
                };
                let id = uuid::Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO starred_sessions(id,start,end,hd_requested,revision,name) VALUES(?1,?2,?3,0,1,NULLIF(?4,''))")
                    .bind(&id).bind(stamp(interval.start)?).bind(stamp(end)?).bind(&next.name)
                    .execute(&mut **tx.conn()).await?;
            }
        }
        if next.phase != FocusedPhase::Deleted {
            sqlx::query("INSERT INTO focused_recording_preferences(singleton,voice_enabled) VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET voice_enabled=excluded.voice_enabled WHERE voice_enabled<>excluded.voice_enabled")
                .bind(next.voice_enabled).execute(&mut **tx.conn()).await?;
        }
        if next.phase == FocusedPhase::Deleted {
            sqlx::query("DELETE FROM focused_recording_audio WHERE recording_id=?1")
                .bind(&next.id)
                .execute(&mut **tx.conn())
                .await?;
        }
        tx.commit().await?;
        *value = next;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_save_projects_pause_intervals_once_without_the_gap() {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new(
            dir.path().join("projection.db").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let mut session = FocusedRecording::new("fixture".into(), 1000, false);
        session
            .apply(
                FocusedAction::Rename {
                    name: "Fixture job".into(),
                },
                1000,
            )
            .unwrap();
        session.apply(FocusedAction::Pause, 2000).unwrap();
        session.apply(FocusedAction::Resume, 5000).unwrap();
        session.apply(FocusedAction::Finish, 6000).unwrap();
        session.apply(FocusedAction::Submit, 6000).unwrap();
        assert!(db.save_focused_recording(&mut session, 0).await.unwrap());
        let rows = db
            .list_starred_sessions("1970", "2100", 100, 0)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|s| s.name.as_deref() == Some("Fixture job")));
        assert_eq!(
            db.starred_timestamps(&[
                "1970-01-01T00:00:01.500Z".into(),
                "1970-01-01T00:00:03.000Z".into(),
                "1970-01-01T00:00:05.500Z".into()
            ])
            .await
            .unwrap(),
            vec![true, false, true]
        );
        let ids: Vec<_> = rows.iter().map(|s| s.id.clone()).collect();
        assert!(db.save_focused_recording(&mut session, 0).await.unwrap());
        assert_eq!(
            db.list_starred_sessions("1970", "2100", 100, 0)
                .await
                .unwrap()
                .iter()
                .map(|s| s.id.clone())
                .collect::<Vec<_>>(),
            ids
        );
        // Older star clients can edit intervals without erasing the capture name.
        let row = &rows[0];
        assert!(db
            .save_starred_session(&row.id, &row.start, &row.end, true, row.revision, "2100")
            .await
            .unwrap());
        assert_eq!(
            db.get_starred_session(&row.id)
                .await
                .unwrap()
                .unwrap()
                .name
                .as_deref(),
            Some("Fixture job")
        );
    }

    #[test]
    fn pause_finish_and_resume_preserve_the_same_capture_without_review_time() {
        let mut session = FocusedRecording::new("one".into(), 1000, false);
        session
            .apply(
                FocusedAction::Rename {
                    name: "Approve an invoice".into(),
                },
                2000,
            )
            .unwrap();
        session.apply(FocusedAction::Pause, 6000).unwrap();
        assert_eq!(session.elapsed_ms(9000), 5000);
        session.apply(FocusedAction::Finish, 10000).unwrap();
        assert_eq!(session.elapsed_ms(30000), 5000);
        session.apply(FocusedAction::Resume, 31000).unwrap();
        session.apply(FocusedAction::Finish, 34000).unwrap();
        assert_eq!(session.id, "one");
        assert_eq!(session.name, "Approve an invoice");
        assert_eq!(session.elapsed_ms(60000), 8000);
        assert_eq!(session.intervals.len(), 2);
    }

    #[test]
    fn repeated_resume_does_not_reset_a_running_interval() {
        let mut session = FocusedRecording::new("one".into(), 1000, true);
        session.apply(FocusedAction::Resume, 4000).unwrap();
        assert_eq!(session.elapsed_ms(5000), 4000);
        assert_eq!(session.intervals.len(), 1);
    }

    #[test]
    fn summary_and_submitted_states_require_explicit_valid_actions() {
        let mut session = FocusedRecording::new("one".into(), 1000, true);
        assert!(session.apply(FocusedAction::Submit, 2000).is_err());
        assert!(session
            .apply(FocusedAction::Delete { confirmed: true }, 2000)
            .is_err());
        session.apply(FocusedAction::Finish, 2000).unwrap();
        assert!(session.apply(FocusedAction::Submit, 3000).is_err());
        session
            .apply(
                FocusedAction::Rename {
                    name: "  Fixture workflow  ".into(),
                },
                4000,
            )
            .unwrap();
        assert!(session
            .apply(FocusedAction::Delete { confirmed: false }, 5000)
            .is_err());
        session.apply(FocusedAction::Submit, 5000).unwrap();
        assert_eq!(session.phase, FocusedPhase::Submitted);
        assert!(session
            .apply(
                FocusedAction::Rename {
                    name: "Changed".into()
                },
                6000
            )
            .is_err());
        assert!(session.apply(FocusedAction::Resume, 6000).is_err());
    }

    #[tokio::test]
    async fn draft_and_pause_gaps_survive_restart_and_stale_writes_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("focus.db");
        let db = super::super::DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        let mut session = FocusedRecording::new("one".into(), 1000, false);
        assert!(db.save_focused_recording(&mut session, 0).await.unwrap());
        let stale = session.clone();
        session.apply(FocusedAction::Pause, 6000).unwrap();
        assert!(db.save_focused_recording(&mut session, 1).await.unwrap());
        let mut stale = stale;
        stale.apply(FocusedAction::Finish, 9000).unwrap();
        assert!(!db.save_focused_recording(&mut stale, 1).await.unwrap());
        drop(db);
        let db = super::super::DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        let restored = db.current_focused_recording().await.unwrap().unwrap();
        assert_eq!(restored.phase, FocusedPhase::Paused);
        assert_eq!(restored.elapsed_ms(30000), 5000);
    }
}

#[cfg(test)]
mod media_tests {
    use super::*;
    #[tokio::test]
    async fn raw_audio_is_available_without_transcription_and_pause_gaps_are_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.db");
        let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
            .await
            .unwrap();
        let mut session = FocusedRecording::new("one".into(), 1000, true);
        assert!(db.save_focused_recording(&mut session, 0).await.unwrap());
        // A real zero-duration chunk still represents available captured media.
        assert!(db
            .save_focused_audio(
                "one",
                "chunk",
                "stream",
                0,
                1000,
                1000,
                "audio/webm",
                b"voice"
            )
            .await
            .unwrap());
        assert!(db
            .save_focused_audio(
                "one",
                "chunk",
                "stream",
                0,
                1000,
                1000,
                "audio/webm",
                b"voice"
            )
            .await
            .unwrap());
        assert!(!db
            .save_focused_audio(
                "one",
                "chunk",
                "stream",
                0,
                1000,
                1000,
                "audio/webm",
                b"changed"
            )
            .await
            .unwrap());
        assert!(!db
            .save_focused_audio(
                "one",
                "later",
                "stream",
                2,
                1000,
                2000,
                "audio/webm",
                b"gap"
            )
            .await
            .unwrap());
        session.apply(FocusedAction::Pause, 2000).unwrap();
        session.apply(FocusedAction::Resume, 4000).unwrap();
        assert!(db.save_focused_recording(&mut session, 1).await.unwrap());
        assert!(!db
            .save_focused_audio(
                "one",
                "pause",
                "another",
                0,
                2500,
                3500,
                "audio/webm",
                b"paused"
            )
            .await
            .unwrap());
        session.apply(FocusedAction::Finish, 5000).unwrap();
        let media = db.focused_recording_media(&session).await.unwrap();
        assert_eq!(media.audio_chunks, 1);
        assert_eq!(media.audio_seconds, 0.0);
        assert_eq!(media.screen_frames, 0);
        session
            .apply(FocusedAction::Delete { confirmed: true }, 6000)
            .unwrap();
        assert!(db.save_focused_recording(&mut session, 2).await.unwrap());
        assert_eq!(
            db.focused_recording_media(&session)
                .await
                .unwrap()
                .audio_chunks,
            0
        );
        assert!(db.current_focused_recording().await.unwrap().is_none());
    }
}

#[cfg(test)]
mod preference_tests {
    use super::*;
    #[tokio::test]
    async fn voice_preference_survives_deleting_a_workflow_in_hybrid_storage() {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new_hybrid(dir.path(), Default::default(), Default::default())
            .await
            .unwrap();
        assert_eq!(db.focused_voice_preference().await.unwrap(), None);
        let mut session = FocusedRecording::new("fixture".into(), 1000, false);
        assert!(db.save_focused_recording(&mut session, 0).await.unwrap());
        assert_eq!(db.focused_voice_preference().await.unwrap(), Some(false));
        session
            .apply(FocusedAction::Voice { enabled: true }, 2000)
            .unwrap();
        assert!(db.save_focused_recording(&mut session, 1).await.unwrap());
        session.apply(FocusedAction::Finish, 3000).unwrap();
        session
            .apply(FocusedAction::Delete { confirmed: true }, 4000)
            .unwrap();
        assert!(db.save_focused_recording(&mut session, 2).await.unwrap());
        assert!(db.current_focused_recording().await.unwrap().is_none());
        assert_eq!(db.focused_voice_preference().await.unwrap(), Some(true));
    }
}

#[cfg(test)]
mod retirement_tests {
    use super::*;
    #[tokio::test]
    async fn retiring_an_inaccessible_draft_keeps_its_content_and_frees_the_capture_slot() {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new(
            dir.path().join("retired.db").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let mut old = FocusedRecording::new("old".into(), 1000, true);
        old.apply(
            FocusedAction::Rename {
                name: "Saved workflow".into(),
            },
            1000,
        )
        .unwrap();
        assert!(db.save_focused_recording(&mut old, 0).await.unwrap());
        assert!(db
            .save_focused_audio(
                "old",
                "audio",
                "stream",
                0,
                1000,
                1500,
                "audio/webm",
                b"voice"
            )
            .await
            .unwrap());
        old.apply(FocusedAction::Finish, 2000).unwrap();
        assert!(db.retire_focused_recording(&mut old, 1).await.unwrap());
        let saved = db.get_focused_recording("old").await.unwrap().unwrap();
        assert_eq!(saved.name, "Saved workflow");
        assert_eq!(
            db.focused_recording_media(&saved)
                .await
                .unwrap()
                .audio_chunks,
            1
        );
        let mut new = FocusedRecording::new("new".into(), 3000, false);
        assert!(db.save_focused_recording(&mut new, 0).await.unwrap());
        assert_eq!(
            db.current_focused_recording().await.unwrap().unwrap().id,
            "new"
        );
    }
}

#[cfg(test)]
mod interruption_tests {
    use super::*;
    #[tokio::test]
    async fn interrupted_narration_tail_is_preserved_after_retirement_and_can_finish() {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new(
            dir.path().join("tail.db").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let mut value = FocusedRecording::new("capture".into(), 1000, true);
        assert!(db.save_focused_recording(&mut value, 0).await.unwrap());
        value.pause_interrupted(2000).unwrap();
        assert!(db.retire_focused_recording(&mut value, 1).await.unwrap());
        assert!(db
            .save_focused_audio(
                "capture",
                "tail",
                "stream",
                0,
                1000,
                7000,
                "audio/webm",
                b"voice"
            )
            .await
            .unwrap());
        let mut restored = db.get_focused_recording("capture").await.unwrap().unwrap();
        assert_eq!(restored.elapsed_ms(50000), 6000);
        let revision = restored.revision;
        restored.apply(FocusedAction::Finish, 8000).unwrap();
        assert!(db
            .save_focused_recording(&mut restored, revision)
            .await
            .unwrap());
        assert_eq!(restored.elapsed_ms(90000), 6000);
    }
}
