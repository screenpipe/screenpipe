// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Preserve the existing history API while the desktop has been quit.

use axum::{
    extract::Request,
    http::Method,
    middleware::Next,
    response::{IntoResponse, Response},
};

static MUTATIONS: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

/// Called after suspending work, before stopping capture. The middleware holds
/// a reader until each admitted mutation has finished dispatching.
pub async fn finish_in_flight_mutations() {
    let _drained = MUTATIONS.write().await;
}

fn history_request(method: &Method, path: &str) -> bool {
    if method == Method::OPTIONS {
        return true;
    }
    if method == Method::POST {
        // raw_sql already enforces read-only SQL and the history access policy.
        return matches!(
            path,
            "/raw_sql" | "/tags/vision/batch" | "/export" | "/vault/lock" | "/vault/unlock"
        );
    }
    if method != Method::GET && method != Method::HEAD {
        return false;
    }
    matches!(
        path,
        "/search"
            | "/search/keyword"
            | "/semantic/actors/search"
            | "/health"
            | "/elements"
            | "/activity-summary"
            | "/activity-ledger"
            | "/artifacts"
            | "/tags/autocomplete"
            | "/openapi.json"
            | "/openapi.yaml"
            | "/vault/status"
            | "/audio/device/status"
            | "/vision/device/status"
            | "/vision/status"
            | "/vision/metrics"
            | "/audio/metrics"
            | "/capture/hd"
    ) || ["/frames", "/speakers", "/meetings", "/memories"]
        .iter()
        .any(|prefix| {
            path == *prefix
                || path
                    .strip_prefix(prefix)
                    .is_some_and(|tail| tail.starts_with('/'))
        })
}

pub async fn history_only(req: Request, next: Next) -> Response {
    let _mutation = if history_request(req.method(), req.uri().path()) {
        None
    } else {
        Some(MUTATIONS.read().await)
    };
    enforce(screenpipe_core::background_work::is_suspended(), req, next).await
}

async fn enforce(active: bool, req: Request, next: Next) -> Response {
    if active && !history_request(req.method(), req.uri().path()) {
        return (axum::http::StatusCode::CONFLICT, axum::Json(serde_json::json!({
            "error": "search_only",
            "message": "Screenpipe was quit and is serving saved history. Open Screenpipe to use this feature."
        }))).into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::any, Router};
    use std::sync::Arc;
    use tower::ServiceExt;

    #[tokio::test]
    async fn quit_drains_admitted_mutations_and_rejects_late_starts() {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                screenpipe_core::background_work::set_suspended(false);
            }
        }
        let _reset = Reset;
        let started = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        let router = Router::new()
            .route(
                "/audio/start",
                any({
                    let started = started.clone();
                    let finish = finish.clone();
                    move || {
                        let started = started.clone();
                        let finish = finish.clone();
                        async move {
                            started.notify_one();
                            finish.notified().await;
                            "started"
                        }
                    }
                }),
            )
            .layer(axum::middleware::from_fn(history_only));
        let request = || {
            Request::builder()
                .method(Method::POST)
                .uri("/audio/start")
                .body(Body::empty())
                .unwrap()
        };
        let admitted = tokio::spawn(router.clone().oneshot(request()));
        started.notified().await;
        screenpipe_core::background_work::set_suspended(true);
        let mut drain = tokio::spawn(finish_in_flight_mutations());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut drain)
                .await
                .is_err()
        );
        finish.notify_one();
        assert!(admitted.await.unwrap().unwrap().status().is_success());
        tokio::time::timeout(std::time::Duration::from_secs(1), drain)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            router.oneshot(request()).await.unwrap().status(),
            axum::http::StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn quit_serves_history_but_never_dispatches_capture_or_jobs() {
        let router = Router::new()
            .fallback(any(|| async { "history handler reached" }))
            .layer(axum::middleware::from_fn(|req, next| {
                enforce(true, req, next)
            }));
        for (method, path, permitted) in [
            (Method::GET, "/search?q=saved", true),
            (Method::GET, "/frames/42/thumbnail", true),
            (Method::GET, "/meetings/1/transcript", true),
            (Method::POST, "/raw_sql", true),
            (Method::POST, "/audio/start", false),
            (Method::POST, "/vision/device/start", false),
            (Method::POST, "/capture/hd/start", false),
            (Method::POST, "/frames/42/ocr", false),
            (Method::POST, "/pipes/example/run", false),
            (Method::POST, "/connections/browser/eval", false),
            (Method::GET, "/browser/ws", false),
            (Method::GET, "/cloud-agents/cursor-agents", false),
            (Method::POST, "/vault/lock", true),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status().is_success(), permitted, "{path}");
            if !permitted {
                let bytes = axum::body::to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap();
                assert!(std::str::from_utf8(&bytes).unwrap().contains("search_only"));
            }
        }
    }
}
