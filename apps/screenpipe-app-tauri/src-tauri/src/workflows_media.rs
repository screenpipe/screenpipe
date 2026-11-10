// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Capability-scoped, read-only replay proxy. The recorder authorizes every
//! range request. Credentials stay in Rust; video streams directly to the
//! webview without a full-clip memory cache.
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Method, Response, StatusCode},
    routing::get,
    Router,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{OnceCell, Semaphore};

const TTL: Duration = Duration::from_secs(300);
const MAX_ENTRIES: usize = 2;
#[derive(Clone)]
struct Entry {
    url: reqwest::Url,
    api_key: Option<String>,
    touched: Instant,
}
#[derive(Clone)]
struct MediaServer {
    port: u16,
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    client: reqwest::Client,
    streams: Arc<Semaphore>,
}
static SERVER: OnceCell<MediaServer> = OnceCell::const_new();

impl MediaServer {
    fn new(port: u16) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .read_timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "Could not start local replay")?;
        Ok(Self {
            port,
            entries: Default::default(),
            client,
            streams: Arc::new(Semaphore::new(4)),
        })
    }
    fn insert(
        &self,
        base_url: &str,
        chunk_id: i64,
        api_key: Option<String>,
    ) -> Result<String, String> {
        let mut url = reqwest::Url::parse(base_url).map_err(|_| "Invalid local recorder")?;
        if chunk_id <= 0
            || url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            || !url.username().is_empty()
            || url.password().is_some()
            || !matches!(url.path(), "" | "/")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Invalid local recorder".into());
        }
        url.set_path(&format!("/frames/preview-media/{chunk_id}"));
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Recording access unavailable")?;
        entries.retain(|_, value| value.touched.elapsed() < TTL);
        while entries.len() >= MAX_ENTRIES {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, value)| value.touched)
                .map(|(key, _)| key.clone())
            {
                entries.remove(&oldest);
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        entries.insert(
            token.clone(),
            Entry {
                url,
                api_key,
                touched: Instant::now(),
            },
        );
        Ok(format!("http://127.0.0.1:{}/media/{token}", self.port))
    }
    fn release(&self, url: &str) {
        let prefix = format!("http://127.0.0.1:{}/media/", self.port);
        if let Some(token) = url.strip_prefix(&prefix) {
            if let Ok(mut entries) = self.entries.lock() {
                entries.remove(token);
            }
        }
    }
}

async fn server() -> Result<&'static MediaServer, String> {
    SERVER
        .get_or_try_init(|| async {
            let socket = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .map_err(|_| "Could not start local replay")?;
            socket
                .set_nonblocking(true)
                .map_err(|_| "Could not start local replay")?;
            let state = MediaServer::new(
                socket
                    .local_addr()
                    .map_err(|_| "Could not start local replay")?
                    .port(),
            )?;
            let router = Router::new()
                .route("/media/:token", get(serve_media))
                .with_state(state.clone());
            let listener =
                axum::Server::from_tcp(socket).map_err(|_| "Could not start local replay")?;
            tauri::async_runtime::spawn(async move {
                if listener.serve(router.into_make_service()).await.is_err() {
                    tracing::warn!("Workflow replay server stopped");
                }
            });
            let cleanup = state.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    if let Ok(mut entries) = cleanup.entries.lock() {
                        entries.retain(|_, entry| entry.touched.elapsed() < TTL);
                    }
                }
            });
            Ok::<_, String>(state)
        })
        .await
}

pub async fn publish(
    base_url: &str,
    chunk_id: i64,
    api_key: Option<String>,
) -> Result<String, String> {
    server().await?.insert(base_url, chunk_id, api_key)
}

#[tauri::command]
#[specta::specta]
pub fn release_workflow_recording(url: String) {
    if let Some(server) = SERVER.get() {
        server.release(&url);
    }
}

async fn serve_media(
    State(server): State<MediaServer>,
    Path(token): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response<Body> {
    media_response(&server, &token, &method, &headers).await
}

async fn media_response(
    server: &MediaServer,
    token: &str,
    method: &Method,
    headers: &HeaderMap,
) -> Response<Body> {
    let empty = |status| {
        Response::builder()
            .status(status)
            .header("Cache-Control", "no-store")
            .body(Body::empty())
            .unwrap()
    };
    if headers.get("host").and_then(|h| h.to_str().ok())
        != Some(format!("127.0.0.1:{}", server.port).as_str())
    {
        return empty(StatusCode::FORBIDDEN);
    }
    if !matches!(*method, Method::GET | Method::HEAD) {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let origin = headers.get("origin").and_then(|h| h.to_str().ok());
    if origin.is_some_and(|o| {
        !matches!(
            o,
            "tauri://localhost"
                | "http://tauri.localhost"
                | "https://tauri.localhost"
                | "http://localhost:1430"
                | "http://127.0.0.1:1430"
        )
    }) {
        return empty(StatusCode::FORBIDDEN);
    }
    let entry = server.entries.lock().ok().and_then(|mut entries| {
        entries.retain(|_, entry| entry.touched.elapsed() < TTL);
        entries.get_mut(token).map(|entry| {
            entry.touched = Instant::now();
            entry.clone()
        })
    });
    let Some(entry) = entry else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(permit) = server.streams.clone().try_acquire_owned() else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let mut request = if *method == Method::HEAD {
        server.client.head(entry.url)
    } else {
        server.client.get(entry.url)
    };
    if let Some(key) = entry.api_key {
        request = request.bearer_auth(key);
    }
    if let Some(range) = headers.get("range").and_then(|value| value.to_str().ok()) {
        request = request.header("Range", range);
    }
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(_) => return empty(StatusCode::BAD_GATEWAY),
    };
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if !matches!(
        status,
        StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE
    ) {
        return empty(
            if matches!(
                status,
                StatusCode::UNAUTHORIZED
                    | StatusCode::FORBIDDEN
                    | StatusCode::NOT_FOUND
                    | StatusCode::SERVICE_UNAVAILABLE
            ) {
                status
            } else {
                StatusCode::BAD_GATEWAY
            },
        );
    }
    if status != StatusCode::RANGE_NOT_SATISFIABLE
        && upstream
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            != Some("video/mp4")
    {
        return empty(StatusCode::BAD_GATEWAY);
    }
    let mut response = Response::builder()
        .status(status)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff");
    for name in [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
    ] {
        if let Some(value) = upstream
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
        {
            response = response.header(name, value);
        }
    }
    if let Some(origin) = origin {
        response = response.header("Access-Control-Allow-Origin", origin);
    }
    let body = if *method == Method::HEAD || status == StatusCode::RANGE_NOT_SATISFIABLE {
        Body::empty()
    } else {
        // Pull only as the browser consumes data. Dropping the body drops the
        // upstream response and permit; no clip-sized allocations or decoding.
        Body::wrap_stream(futures::stream::try_unfold(
            (upstream, permit),
            |(mut upstream, permit)| async move {
                upstream
                    .chunk()
                    .await
                    .map(|chunk| chunk.map(|bytes| (bytes, (upstream, permit))))
                    .map_err(|_| std::io::Error::other("Recording stream interrupted"))
            },
        ))
    };
    response.body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    #[derive(Clone, Default)]
    struct Recorder {
        denied: Arc<AtomicBool>,
        requests: Arc<AtomicUsize>,
    }
    async fn mock_media(
        State(state): State<Recorder>,
        method: Method,
        headers: HeaderMap,
    ) -> Response<Body> {
        state.requests.fetch_add(1, Ordering::SeqCst);
        assert_eq!(headers["authorization"], "Bearer synthetic-test-key");
        if state.denied.load(Ordering::SeqCst) {
            return Response::builder()
                .status(503)
                .body(Body::from("private error"))
                .unwrap();
        }
        assert!(matches!(method, Method::GET | Method::HEAD));
        assert_eq!(headers["range"], "bytes=20000000-20000001");
        Response::builder()
            .status(206)
            .header("content-type", "video/mp4")
            .header("accept-ranges", "bytes")
            .header("content-length", "2")
            .header("content-range", "bytes 20000000-20000001/64000000")
            .body(if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(vec![7, 8])
            })
            .unwrap()
    }
    fn fixture(base: &str) -> (MediaServer, String, HeaderMap) {
        let server = MediaServer::new(12345).unwrap();
        let url = server
            .insert(base, 42, Some("synthetic-test-key".into()))
            .unwrap();
        let token = url.rsplit('/').next().unwrap().to_string();
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:12345".parse().unwrap());
        (server, token, headers)
    }
    #[tokio::test]
    async fn streams_large_clip_ranges_lazily_and_rechecks_recorder_privacy() {
        let state = Recorder::default();
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        socket.set_nonblocking(true).unwrap();
        let base = format!("http://{}", socket.local_addr().unwrap());
        let router = Router::new()
            .route("/frames/preview-media/42", get(mock_media))
            .with_state(state.clone());
        let listener = tokio::spawn(
            axum::Server::from_tcp(socket)
                .unwrap()
                .serve(router.into_make_service()),
        );
        let (server, token, mut headers) = fixture(&base);
        assert_eq!(
            state.requests.load(Ordering::SeqCst),
            0,
            "publishing a capability must not download video"
        );
        headers.insert("range", "bytes=20000000-20000001".parse().unwrap());
        let response = media_response(&server, &token, &Method::GET, &headers).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers()["content-range"],
            "bytes 20000000-20000001/64000000"
        );
        assert_eq!(response.headers()["cache-control"], "no-store");
        use axum::body::HttpBody;
        let mut body = response.into_body();
        assert_eq!(body.data().await.unwrap().unwrap().as_ref(), &[7, 8]);
        drop(body);
        let head = media_response(&server, &token, &Method::HEAD, &headers).await;
        assert_eq!(head.status(), StatusCode::PARTIAL_CONTENT);
        assert!(head.into_body().data().await.is_none());
        // Exercise both HTTP hops, not just the handler, including the range
        // contract used by WebKit for clips larger than the former 16 MiB cap.
        let proxy_socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        proxy_socket.set_nonblocking(true).unwrap();
        let mut proxy = server.clone();
        proxy.port = proxy_socket.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{}/media/{token}", proxy.port);
        let router = Router::new()
            .route("/media/:token", get(serve_media))
            .with_state(proxy);
        let proxy_listener = tokio::spawn(
            axum::Server::from_tcp(proxy_socket)
                .unwrap()
                .serve(router.into_make_service()),
        );
        let response = reqwest::Client::new()
            .get(&url)
            .header("Range", "bytes=20000000-20000001")
            .header("Origin", "tauri://localhost")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 206);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "tauri://localhost"
        );
        assert_eq!(response.bytes().await.unwrap().as_ref(), &[7, 8]);
        proxy_listener.abort();
        let slots = server.streams.clone().try_acquire_many_owned(4).unwrap();
        assert_eq!(
            media_response(&server, &token, &Method::GET, &headers)
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state.requests.load(Ordering::SeqCst),
            3,
            "excess streams must not reach capture"
        );
        drop(slots);
        state.denied.store(true, Ordering::SeqCst);
        let denied = media_response(&server, &token, &Method::GET, &headers).await;
        assert_eq!(
            denied.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a cached capability cannot bypass changed privacy policy"
        );
        assert!(denied.into_body().data().await.is_none());
        server.release(&format!("http://127.0.0.1:12345/media/{token}"));
        assert_eq!(
            media_response(&server, &token, &Method::GET, &headers)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(state.requests.load(Ordering::SeqCst), 4);
        listener.abort();
    }
    #[tokio::test]
    async fn rejects_remote_origins_rebinding_expired_and_unknown_capabilities() {
        let (server, token, mut headers) = fixture("http://127.0.0.1:3030");
        assert_eq!(
            media_response(&server, "unknown", &Method::GET, &headers)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        headers.insert("origin", "https://evil.example".parse().unwrap());
        assert_eq!(
            media_response(&server, &token, &Method::GET, &headers)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        headers.remove("origin");
        headers.insert("host", "evil.example:12345".parse().unwrap());
        assert_eq!(
            media_response(&server, &token, &Method::GET, &headers)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        headers.insert("host", "127.0.0.1:12345".parse().unwrap());
        assert_eq!(
            media_response(&server, &token, &Method::POST, &headers)
                .await
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        server
            .entries
            .lock()
            .unwrap()
            .get_mut(&token)
            .unwrap()
            .touched = Instant::now() - TTL;
        assert_eq!(
            media_response(&server, &token, &Method::GET, &headers)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    #[test]
    fn bounds_capabilities_and_rejects_non_recorder_targets() {
        let (server, _, _) = fixture("http://127.0.0.1:3030");
        for _ in 0..5 {
            server.insert("http://127.0.0.1:3030", 42, None).unwrap();
        }
        assert_eq!(server.entries.lock().unwrap().len(), MAX_ENTRIES);
        for base in [
            "https://example.com",
            "http://127.0.0.1.evil.test",
            "http://secret@localhost:3030",
            "http://localhost:3030/private",
            "http://localhost:3030?path=private",
        ] {
            assert!(server.insert(base, 42, None).is_err());
        }
        assert!(server.insert("http://127.0.0.1:3030", 0, None).is_err());
    }
}
