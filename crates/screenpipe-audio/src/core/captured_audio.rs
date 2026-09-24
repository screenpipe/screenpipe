// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use std::{
    ops::Deref,
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;

static CAPTURE_EPOCH: OnceLock<(Instant, u64)> = OnceLock::new();

/// Timestamp before the async broadcast, so queue delay and subscription time
/// cannot shift microphone and render clocks independently. This estimates the
/// first sample from callback delivery; it is not a hardware presentation time.
#[derive(Clone, Debug)]
pub struct CapturedAudio {
    pub samples: Vec<f32>,
    delivered_at: Instant,
}

impl CapturedAudio {
    pub fn start_timestamp_ms(&self, sample_rate: u32) -> u64 {
        let (instant, unix_ms) = CAPTURE_EPOCH.get().expect("capture channel initialized");
        let start =
            self.delivered_at - Duration::from_secs_f64(self.len() as f64 / sample_rate as f64);
        if start >= *instant {
            unix_ms.saturating_add(start.duration_since(*instant).as_millis() as u64)
        } else {
            unix_ms.saturating_sub(instant.duration_since(start).as_millis() as u64)
        }
    }
}

impl Deref for CapturedAudio {
    type Target = [f32];
    fn deref(&self) -> &[f32] {
        &self.samples
    }
}

/// Same sample ownership and broadcast capacity as before. The callback adds
/// only a monotonic timestamp, with no additional allocation or lock.
#[derive(Clone)]
pub struct CaptureSender(broadcast::Sender<CapturedAudio>);
impl CaptureSender {
    pub fn new(capacity: usize) -> Self {
        CAPTURE_EPOCH.get_or_init(|| {
            (
                Instant::now(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            )
        });
        Self(broadcast::channel(capacity).0)
    }
    pub fn send(
        &self,
        samples: Vec<f32>,
    ) -> Result<usize, broadcast::error::SendError<CapturedAudio>> {
        self.0.send(CapturedAudio {
            samples,
            delivered_at: Instant::now(),
        })
    }
    pub fn subscribe(&self) -> broadcast::Receiver<CapturedAudio> {
        self.0.subscribe()
    }
    pub fn receiver_count(&self) -> usize {
        self.0.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queue_delay_does_not_move_capture_time() {
        let tx = CaptureSender::new(4);
        let mut first = tx.subscribe();
        let mut delayed = tx.subscribe();
        tx.send(vec![0.2; 160]).unwrap();
        let stamp = first.recv().await.unwrap().start_timestamp_ms(16000);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            stamp,
            delayed.recv().await.unwrap().start_timestamp_ms(16000)
        );
    }
    #[tokio::test]
    async fn lag_does_not_compress_the_capture_clock() {
        let tx = CaptureSender::new(2);
        let mut rx = tx.subscribe();
        tx.send(vec![0.2; 160]).unwrap();
        let first = rx.recv().await.unwrap().start_timestamp_ms(16000);
        tokio::time::sleep(Duration::from_millis(30)).await;
        for _ in 0..4 {
            tx.send(vec![0.2; 160]).unwrap();
        }
        assert!(matches!(
            rx.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));
        assert!(rx.recv().await.unwrap().start_timestamp_ms(16000) >= first + 25);
    }
}
