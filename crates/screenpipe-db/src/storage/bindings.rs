// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use crate::DatabaseManager;

impl DatabaseManager {
    /// Preserve legacy record addresses; fresh histories use their persisted
    /// database identity so a reset cannot reuse an earlier history's row IDs.
    pub async fn consumer_sync_source_id(&self, device_id: &str) -> Result<String, sqlx::Error> {
        if self
            .storage
            .as_ref()
            .is_some_and(|s| !s.descriptor.source_continuity)
        {
            return self.upload_source_id().await.map(str::to_owned);
        }
        Ok(device_id.to_owned())
    }

    pub async fn upload_checkpoint(
        &self,
        destination: &str,
    ) -> Result<Option<String>, sqlx::Error> {
        if self.storage.is_none() {
            return Ok(None);
        }
        sqlx::query_scalar("SELECT checkpoint FROM upload_bindings WHERE destination=?")
            .bind(destination)
            .fetch_optional(&self.pool)
            .await
    }

    pub async fn save_upload_checkpoint(
        &self,
        destination: &str,
        checkpoint: &str,
    ) -> Result<(), sqlx::Error> {
        if self.storage.is_none() {
            return Ok(());
        }
        let mut tx = self.begin_immediate_with_retry().await?;
        sqlx::query("INSERT INTO upload_bindings(destination,checkpoint) VALUES(?,?) ON CONFLICT(destination) DO UPDATE SET checkpoint=excluded.checkpoint")
            .bind(destination).bind(checkpoint).execute(&mut **tx.conn()).await?;
        tx.commit().await
    }
}
