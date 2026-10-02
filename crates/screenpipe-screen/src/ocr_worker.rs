// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! A bounded, lazy OS thread for work that must not inherit a shared pool's COM mode.
use std::sync::{mpsc, Mutex};

pub(crate) struct OcrWorker<T> {
    sender: Mutex<Option<mpsc::SyncSender<T>>>,
    handle: fn(T),
}

impl<T: Send + 'static> OcrWorker<T> {
    pub(crate) const fn new(handle: fn(T)) -> Self {
        Self {
            sender: Mutex::new(None),
            handle,
        }
    }

    pub(crate) fn submit(&self, mut request: T) -> Result<(), String> {
        let mut sender = self.sender.lock().map_err(|_| "OCR worker lock poisoned")?;
        // A dead worker may be replaced once. Never retry a job already accepted.
        for _ in 0..2 {
            if sender.is_none() {
                let (tx, rx) = mpsc::sync_channel(1);
                let handle = self.handle;
                std::thread::Builder::new()
                    .name("screenpipe-windows-ocr".into())
                    .spawn(move || {
                        for request in rx {
                            handle(request);
                        }
                    })
                    .map_err(|error| format!("Could not start OCR worker: {error}"))?;
                *sender = Some(tx);
            }
            match sender.as_ref().unwrap().try_send(request) {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Full(_)) => return Err("OCR worker queue full".into()),
                Err(mpsc::TrySendError::Disconnected(returned)) => {
                    *sender = None;
                    request = returned;
                }
            }
        }
        Err("OCR worker stopped before accepting the request".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn reuses_an_isolated_thread() {
        let worker = OcrWorker::new(|reply: mpsc::Sender<thread::ThreadId>| {
            reply.send(thread::current().id()).unwrap();
        });
        let (tx, rx) = mpsc::channel();
        worker.submit(tx.clone()).unwrap();
        let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.submit(tx).unwrap();
        assert_eq!(first, rx.recv_timeout(Duration::from_secs(5)).unwrap());
        assert_ne!(first, thread::current().id());
    }

    struct Job {
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    #[test]
    fn queue_is_bounded_while_worker_is_busy() {
        let worker = OcrWorker::new(|job: Job| {
            job.started.send(()).unwrap();
            job.release.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        let (started, observed) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        worker
            .submit(Job {
                started: started.clone(),
                release: wait,
            })
            .unwrap();
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        let (release_next, wait_next) = mpsc::channel();
        worker
            .submit(Job {
                started: started.clone(),
                release: wait_next,
            })
            .unwrap();
        let (_, wait_overflow) = mpsc::channel();
        assert!(worker
            .submit(Job {
                started,
                release: wait_overflow
            })
            .unwrap_err()
            .contains("queue full"));
        release.send(()).unwrap();
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        release_next.send(()).unwrap();
    }

    #[test]
    fn replaces_disconnected_worker_without_losing_request() {
        let worker = OcrWorker::new(|reply: mpsc::Sender<()>| {
            reply.send(()).unwrap();
        });
        // Model a previous worker's receiver having gone away, without a sleep/race.
        let (dead_sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        *worker.sender.lock().unwrap() = Some(dead_sender);
        let (tx, rx) = mpsc::channel();
        worker.submit(tx).unwrap();
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}
