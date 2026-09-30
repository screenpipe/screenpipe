// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Ephemeral, capability-scoped loopback media. WebKit needs real byte-range
//! responses for reliable MP4 seeking; recorder credentials never leave Rust.
use axum::{body::Body, extract::{Path, State}, http::{HeaderMap, Method, Response, StatusCode}, routing::get, Router};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio::sync::OnceCell;

const TTL: Duration = Duration::from_secs(300);
const MAX_MEDIA: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 2;
struct Entry { bytes: Arc<Vec<u8>>, created: Instant }
#[derive(Clone)]
struct MediaServer { port: u16, entries: Arc<Mutex<HashMap<String, Entry>>> }
static SERVER: OnceCell<MediaServer> = OnceCell::const_new();

impl MediaServer {
    fn insert(&self, bytes: Vec<u8>) -> Result<String, String> {
        if bytes.is_empty() || bytes.len() > MAX_MEDIA { return Err("Recording exceeds the inline preview limit".into()); }
        let mut entries = self.entries.lock().map_err(|_| "Recording cache unavailable")?;
        entries.retain(|_, value| value.created.elapsed() < TTL);
        while entries.len() >= MAX_ENTRIES {
            if let Some(oldest) = entries.iter().min_by_key(|(_, value)| value.created).map(|(key, _)| key.clone()) { entries.remove(&oldest); }
        }
        let token = uuid::Uuid::new_v4().to_string();
        entries.insert(token.clone(), Entry { bytes: Arc::new(bytes), created: Instant::now() });
        Ok(format!("http://127.0.0.1:{}/media/{token}", self.port))
    }
}

async fn server() -> Result<&'static MediaServer, String> {
    SERVER.get_or_try_init(|| async {
        let socket = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|_| "Could not start local replay")?;
        socket.set_nonblocking(true).map_err(|_| "Could not start local replay")?;
        let state = MediaServer { port: socket.local_addr().map_err(|_| "Could not start local replay")?.port(), entries: Default::default() };
        let router = Router::new().route("/media/:token", get(serve_media)).with_state(state.clone());
        let listener = axum::Server::from_tcp(socket).map_err(|_| "Could not start local replay")?;
        tauri::async_runtime::spawn(async move { if listener.serve(router.into_make_service()).await.is_err() { tracing::warn!("Workflow replay server stopped"); } });
        let cleanup = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                if let Ok(mut entries) = cleanup.entries.lock() { entries.retain(|_, entry| entry.created.elapsed() < TTL); }
            }
        });
        Ok::<_, String>(state)
    }).await
}

pub async fn publish(bytes: Vec<u8>) -> Result<String, String> { server().await?.insert(bytes) }

#[tauri::command]
#[specta::specta]
pub fn release_workflow_recording(url: String) {
    let Some(server) = SERVER.get() else { return; };
    let prefix = format!("http://127.0.0.1:{}/media/", server.port);
    if let Some(token) = url.strip_prefix(&prefix) {
        if let Ok(mut entries) = server.entries.lock() { entries.remove(token); }
    }
}

fn byte_range(range: &str, length: usize) -> Option<(usize, usize)> {
    if length == 0 { return None; }
    let (start, end) = range.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<usize>().ok()?;
        return (suffix > 0).then_some((length.saturating_sub(suffix), length - 1));
    }
    let start = start.parse::<usize>().ok()?;
    let end = if end.is_empty() { length - 1 } else { end.parse::<usize>().ok()?.min(length - 1) };
    (start <= end && start < length).then_some((start, end))
}

async fn serve_media(State(server): State<MediaServer>, Path(token): Path<String>, method: Method, headers: HeaderMap) -> Response<Body> {
    media_response(&server, &token, &method, &headers)
}

fn media_response(server: &MediaServer, token: &str, method: &Method, headers: &HeaderMap) -> Response<Body> {
    let empty = |status| Response::builder().status(status).header("Cache-Control", "no-store").body(Body::empty()).unwrap();
    if headers.get("host").and_then(|h| h.to_str().ok()) != Some(format!("127.0.0.1:{}", server.port).as_str()) { return empty(StatusCode::FORBIDDEN); }
    if !matches!(*method, Method::GET | Method::HEAD) { return empty(StatusCode::METHOD_NOT_ALLOWED); }
    let origin = headers.get("origin").and_then(|h| h.to_str().ok());
    if origin.is_some_and(|o| !matches!(o, "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost" | "http://localhost:1430" | "http://127.0.0.1:1430")) { return empty(StatusCode::FORBIDDEN); }
    let bytes = server.entries.lock().ok().and_then(|mut entries| {
        entries.retain(|_, entry| entry.created.elapsed() < TTL);
        entries.get(token).map(|entry| entry.bytes.clone())
    });
    let Some(bytes) = bytes else { return empty(StatusCode::NOT_FOUND); };
    let range = headers.get("range");
    let (start, end) = if let Some(range) = range {
        match range.to_str().ok().and_then(|range| byte_range(range, bytes.len())) {
            Some(range) => range,
            None => return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header("Content-Range", format!("bytes */{}", bytes.len())).body(Body::empty()).unwrap(),
        }
    } else { (0, bytes.len() - 1) };
    let mut response = Response::builder()
        .status(if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header("Content-Type", "video/mp4").header("Accept-Ranges", "bytes")
        .header("Content-Length", (end - start + 1).to_string())
        .header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    if range.is_some() { response = response.header("Content-Range", format!("bytes {start}-{end}/{}", bytes.len())); }
    if let Some(origin) = origin { response = response.header("Access-Control-Allow-Origin", origin); }
    response.body(if *method == Method::HEAD { Body::empty() } else { Body::from(bytes[start..=end].to_vec()) }).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn actual_loopback_stream_returns_range_bytes_and_revokes() {
        let url = publish(vec![10, 20, 30, 40, 50]).await.unwrap();
        let response = reqwest::Client::new().get(&url).header("Range", "bytes=1-3").send().await.unwrap();
        assert_eq!(response.status().as_u16(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 1-3/5");
        assert_eq!(response.bytes().await.unwrap().as_ref(), &[20, 30, 40]);
        release_workflow_recording(url.clone());
        assert_eq!(reqwest::get(url).await.unwrap().status().as_u16(), 404);
    }
    fn fixture() -> (MediaServer, String, HeaderMap) {
        let server = MediaServer { port: 12345, entries: Default::default() };
        let url = server.insert(vec![0, 1, 2, 3, 4]).unwrap();
        let token = url.rsplit('/').next().unwrap().to_string();
        let mut headers = HeaderMap::new(); headers.insert("host", "127.0.0.1:12345".parse().unwrap());
        (server, token, headers)
    }
    #[test] fn supports_closed_open_suffix_and_rejects_invalid_ranges() {
        assert_eq!(byte_range("bytes=0-1", 5), Some((0, 1)));
        assert_eq!(byte_range("bytes=3-", 5), Some((3, 4)));
        assert_eq!(byte_range("bytes=-2", 5), Some((3, 4)));
        assert_eq!(byte_range("bytes=0-999", 5), Some((0, 4)));
        for range in ["bytes=6-", "bytes=3-1", "bytes=-0", "bytes=0-1,3-4", "wrong"] { assert_eq!(byte_range(range, 5), None); }
    }
    #[test] fn serves_ranges_and_head_with_correct_metadata() {
        let (server, token, mut headers) = fixture();
        headers.insert("range", "bytes=1-3".parse().unwrap());
        let response = media_response(&server, &token, &Method::GET, &headers);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 1-3/5");
        assert_eq!(response.headers()["content-length"], "3");
        assert_eq!(media_response(&server, &token, &Method::HEAD, &headers).status(), StatusCode::PARTIAL_CONTENT);
        headers.insert("range", "bytes=999-".parse().unwrap());
        assert_eq!(media_response(&server, &token, &Method::GET, &headers).status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }
    #[test] fn refuses_unknown_capabilities_remote_origins_and_rebinding() {
        let (server, token, mut headers) = fixture();
        assert_eq!(media_response(&server, "unknown", &Method::GET, &headers).status(), StatusCode::NOT_FOUND);
        headers.insert("origin", "https://evil.example".parse().unwrap());
        assert_eq!(media_response(&server, &token, &Method::GET, &headers).status(), StatusCode::FORBIDDEN);
        headers.remove("origin"); headers.insert("host", "evil.example:12345".parse().unwrap());
        assert_eq!(media_response(&server, &token, &Method::GET, &headers).status(), StatusCode::FORBIDDEN);
    }
    #[test] fn bounds_memory_and_expires_capabilities() {
        let (server, token, headers) = fixture();
        server.entries.lock().unwrap().get_mut(&token).unwrap().created = Instant::now() - TTL;
        assert_eq!(media_response(&server, &token, &Method::GET, &headers).status(), StatusCode::NOT_FOUND);
        for _ in 0..5 { server.insert(vec![1]).unwrap(); }
        assert_eq!(server.entries.lock().unwrap().len(), MAX_ENTRIES);
        assert!(server.insert(vec![]).is_err());
        assert!(server.insert(vec![0; MAX_MEDIA + 1]).is_err());
    }
}
