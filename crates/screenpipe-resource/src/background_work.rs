// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Cooperative suspension of optional work while the desktop serves history only.
//! Capture admission and database writes never wait on this gate.

use std::sync::LazyLock;
use tokio::sync::watch;

static SUSPENDED: LazyLock<watch::Sender<bool>> = LazyLock::new(|| watch::channel(false).0);

pub fn is_suspended() -> bool {
    *SUSPENDED.borrow()
}

pub fn set_suspended(suspended: bool) {
    SUSPENDED.send_replace(suspended);
}

pub async fn wait_until_resumed() {
    wait_on(&mut SUSPENDED.subscribe()).await;
}

async fn wait_on(state: &mut watch::Receiver<bool>) {
    let _ = state.wait_for(|suspended| !*suspended).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn suspended_work_waits_without_losing_a_resume() {
        let (state, mut reader) = watch::channel(true);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), wait_on(&mut reader))
                .await
                .is_err()
        );
        state.send_replace(false);
        tokio::time::timeout(Duration::from_secs(1), wait_on(&mut reader))
            .await
            .unwrap();
        state.send_replace(true);
        state.send_replace(false);
        tokio::time::timeout(Duration::from_secs(1), wait_on(&mut reader))
            .await
            .unwrap();
    }
}
