use anyhow::Result;
use futures::Stream;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Deserialize;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::any::Any;
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

struct SubscriptionEntry {
    last_used: Instant,
    subscription: Box<dyn Any + Send + Sync>,
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

        // Update last_used timestamp when polling
        if let Some(manager) = EVENT_MANAGER.subscriptions.write().get_mut(&me.event_name) {
            manager.last_used = Instant::now();
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
        // Remove subscription from manager when dropped
        if let Some(manager) = EVENT_MANAGER
            .subscriptions
            .write()
            .get_mut(&self.event_name)
        {
            manager.last_used = Instant::now();
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
        {
            let mut subs = self.subscriptions.write();
            if let Some(entry) = subs.get_mut(&event_name) {
                entry.last_used = Instant::now();
                if let Some(typed_sub) = entry.subscription.downcast_ref::<EventSubscription<T>>() {
                    return typed_sub.clone();
                }
            }
        }

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
                subscription: Box::new(sub.clone()),
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
