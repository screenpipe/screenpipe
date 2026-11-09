// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use anyhow::Result;
use futures::Stream;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Deserialize;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tokio::time::interval;
use tokio_stream::wrappers::BroadcastStream;

static EVENT_MANAGER: Lazy<EventManager> = Lazy::new(EventManager::new);

const CLEANUP_INTERVAL: Duration = Duration::from_secs(60);
const SUBSCRIPTION_TIMEOUT: Duration = Duration::from_secs(600); // 10 minutes

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event<T = Value> {
    pub name: String,
    pub data: T,
}

// Keep metadata only: an unpolled receiver pins otherwise-consumed payloads.
struct SubscriptionEntry {
    last_used: Instant,
}

pub struct EventManager {
    sender: broadcast::Sender<Event>,
    subscriptions: RwLock<HashMap<String, SubscriptionEntry>>,
}

// #[macro_export]
// macro_rules! send_event {
//     ($name:expr, $data:expr) => {{
//         if let Err(e) = $crate::EventManager::instance().send($name, $data) {
//             tracing::error!("Failed to send event {}: {}", $name, e);
//         }
//     }};
// }

pub fn send_event<T: Serialize + 'static>(event: impl Into<String>, data: T) -> Result<()> {
    EventManager::instance().send(event, data)
}

pub struct EventSubscription<T = Value> {
    stream: std::pin::Pin<Box<BroadcastStream<Event>>>,
    event_name: String,
    _phantom: std::marker::PhantomData<T>,
}

impl<T: DeserializeOwned + Send + 'static> Clone for EventSubscription<T> {
    fn clone(&self) -> Self {
        let rx = EVENT_MANAGER.sender.subscribe();
        Self {
            stream: Box::pin(BroadcastStream::new(rx)),
            event_name: self.event_name.clone(),
            _phantom: std::marker::PhantomData,
        }
    }
}

impl<T: DeserializeOwned + Unpin + 'static> Stream for EventSubscription<T> {
    type Item = Event<T>;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let me = self.get_mut();

        // Update last_used timestamp when polling — use try_write to avoid
        // blocking the async runtime if cleanup is holding the lock.
        if let Some(mut subs) = EVENT_MANAGER.subscriptions.try_write() {
            if let Some(entry) = subs.get_mut(&me.event_name) {
                entry.last_used = Instant::now();
            }
        }

        loop {
            match me.stream.as_mut().poll_next(cx) {
                std::task::Poll::Ready(Some(Ok(event))) => {
                    if event.name == me.event_name || me.event_name.is_empty() {
                        if let Ok(data) = serde_json::from_value::<T>(event.data) {
                            return std::task::Poll::Ready(Some(Event {
                                name: event.name,
                                data,
                            }));
                        }
                    }
                }
                std::task::Poll::Ready(Some(_)) => continue,
                std::task::Poll::Ready(None) => return std::task::Poll::Ready(None),
                std::task::Poll::Pending => return std::task::Poll::Pending,
            }
        }
    }
}

impl<T> Drop for EventSubscription<T> {
    fn drop(&mut self) {
        // Try to update last_used, but never block.
        // cleanup_stale_subscriptions() holds this write lock while dropping
        // entries via retain() — if Drop also tries to acquire the same lock,
        // parking_lot deadlocks (it's not reentrant for write locks).
        if let Some(mut subs) = EVENT_MANAGER.subscriptions.try_write() {
            if let Some(entry) = subs.get_mut(&self.event_name) {
                entry.last_used = Instant::now();
            }
        }
    }
}

impl EventManager {
    fn new() -> Self {
        let (sender, _) = broadcast::channel(10000);
        let manager = Self {
            sender,
            subscriptions: RwLock::new(HashMap::new()),
        };

        // spawn cleanup task
        tokio::spawn(async move {
            let mut interval = interval(CLEANUP_INTERVAL);
            loop {
                interval.tick().await;
                EVENT_MANAGER.cleanup_stale_subscriptions();
            }
        });

        manager
    }

    fn cleanup_stale_subscriptions(&self) {
        let mut subs = self.subscriptions.write();
        subs.retain(|_, entry| entry.last_used.elapsed() < SUBSCRIPTION_TIMEOUT);
    }

    pub fn instance() -> &'static EventManager {
        &EVENT_MANAGER
    }

    pub fn send<T: Serialize + 'static>(&self, event: impl Into<String>, data: T) -> Result<()> {
        // Skip serialization entirely when nobody is listening
        if self.sender.receiver_count() == 0 {
            return Ok(());
        }

        let event_name = event.into();
        let value = serde_json::to_value(data)?;

        tracing::debug!("sending event {} ", event_name);
        match self.sender.send(Event {
            name: event_name.clone(),
            data: value,
        }) {
            Ok(_) => Ok(()),
            Err(e) => {
                if !e.to_string().contains("channel closed") {
                    tracing::error!("Failed to send event {}: {}", event_name, e);
                    Err(anyhow::anyhow!(
                        "Failed to send event {}: {}",
                        event_name,
                        e
                    ))
                } else {
                    Ok(())
                }
            }
        }
    }

    pub fn subscribe<T: DeserializeOwned + Unpin + Clone + Send + Sync + 'static>(
        &self,
        event: impl Into<String>,
    ) -> EventSubscription<T> {
        let event_name = event.into();

        let rx = self.sender.subscribe();
        let sub = EventSubscription {
            stream: Box::pin(BroadcastStream::new(rx)),
            event_name: event_name.clone(),
            _phantom: std::marker::PhantomData,
        };

        let mut subs = self.subscriptions.write();
        subs.insert(
            event_name,
            SubscriptionEntry {
                last_used: Instant::now(),
            },
        );
        sub
    }

    pub fn unsubscribe(&self, event: impl Into<String>) {
        let event_name = event.into();
        let mut subs = self.subscriptions.write();
        subs.remove(&event_name);
    }

    pub fn clear_all_subscriptions(&self) {
        let mut subs = self.subscriptions.write();
        subs.clear();
    }
}

pub fn subscribe_to_event<T: DeserializeOwned + Unpin + Clone + Send + Sync + 'static>(
    event: impl Into<String>,
) -> EventSubscription<T> {
    EventManager::instance().subscribe::<T>(event)
}

pub fn subscribe_to_all_events() -> EventSubscription<serde_json::Value> {
    EventManager::instance().subscribe::<serde_json::Value>("")
}

#[cfg(test)]
mod retention_tests {
    use super::*;
    use futures::StreamExt;

    #[tokio::test]
    #[serial_test::serial]
    async fn fully_consumed_events_do_not_remain_retained() {
        let mut subscriber = subscribe_to_event::<serde_json::Value>("memory_probe");
        for i in 0..256 {
            send_event(
                "memory_probe",
                serde_json::json!({"i": i, "payload": "x".repeat(4096)}),
            )
            .unwrap();
            let received = subscriber.next().await.unwrap();
            assert_eq!(received.data["i"], i);
        }
        let retained = EVENT_MANAGER.sender.len();
        assert_eq!(
            retained, 0,
            "event registry's unpolled clone retains consumed JSON payloads"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn dropping_last_consumer_removes_all_receivers() {
        let subscriber = subscribe_to_event::<serde_json::Value>("drop_probe");
        assert_eq!(EVENT_MANAGER.sender.receiver_count(), 1);
        drop(subscriber);
        assert_eq!(EVENT_MANAGER.sender.receiver_count(), 0);
        struct MustNotSerialize;
        impl Serialize for MustNotSerialize {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom(
                    "no listeners should skip serialization",
                ))
            }
        }
        send_event("drop_probe", MustNotSerialize).unwrap();
        assert_eq!(EVENT_MANAGER.sender.len(), 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn release_waits_for_actual_consumers_only() {
        let mut first = subscribe_to_event::<serde_json::Value>("two_probe");
        let mut second = subscribe_to_event::<serde_json::Value>("two_probe");
        assert_eq!(EVENT_MANAGER.sender.receiver_count(), 2);
        send_event("two_probe", serde_json::json!({"payload":"test"})).unwrap();
        first.next().await.unwrap();
        assert_eq!(EVENT_MANAGER.sender.len(), 1);
        second.next().await.unwrap();
        assert_eq!(EVENT_MANAGER.sender.len(), 0);
    }
}
