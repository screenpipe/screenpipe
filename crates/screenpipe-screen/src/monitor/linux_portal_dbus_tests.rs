// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! End-to-end tests for `run_portal_session` against a scripted fake
//! `org.freedesktop.portal.ScreenCast`, served on a private `dbus-daemon`.
//!
//! ashpd caches one session-bus connection per process, taken from
//! `DBUS_SESSION_BUS_ADDRESS`. To avoid mutating the environment of the shared
//! test process, the parent test starts the private bus and the fake portal,
//! then re-runs this test binary with the bus address set for a single
//! `#[ignore]`d child test that drives the real session code. The child only
//! runs when `SCREENPIPE_FAKE_PORTAL_CHILD=1`, so `cargo test -- --ignored`
//! can never reach the user's real portal and pop a screen-share dialog.

use super::*;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};
use zbus::{
    message::Header,
    object_server::SignalEmitter,
    zvariant::{ObjectPath, OwnedValue, Value},
};

const CHILD_ENV: &str = "SCREENPIPE_FAKE_PORTAL_CHILD";
const CHILD_TEST: &str = "monitor::linux_portal::dbus_tests::child_drives_portal_sessions";
const DESKTOP_PATH: &str = "/org/freedesktop/portal/desktop";

/// What the fake portal observed in one `SelectSources` call.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SelectCall {
    restore_token: Option<String>,
    persist_mode: Option<u32>,
}

type StreamProps = HashMap<String, OwnedValue>;

/// One scripted reply to `Start`: the streams and the restore token.
struct StartScript {
    streams: Vec<(u32, StreamProps)>,
    restore_token: &'static str,
}

struct FakeScreenCast {
    select_calls: Arc<Mutex<Vec<SelectCall>>>,
    start_scripts: Arc<Mutex<Vec<StartScript>>>,
}

/// `/org/freedesktop/portal/desktop/request/<sender>/<token>`, the path
/// ashpd listens on for the `Response` signal of a request.
fn request_path(header: &Header<'_>, options: &HashMap<String, OwnedValue>) -> String {
    let sender = header
        .sender()
        .expect("portal calls carry a sender")
        .trim_start_matches(':')
        .replace('.', "_");
    let token: String = options
        .get("handle_token")
        .and_then(|value| value.try_clone().ok())
        .and_then(|value| String::try_from(value).ok())
        .expect("ashpd always sends a handle_token");
    format!("{DESKTOP_PATH}/request/{sender}/{token}")
}

async fn respond(
    connection: &zbus::Connection,
    path: &str,
    results: HashMap<String, OwnedValue>,
) -> zbus::fdo::Result<ObjectPath<'static>> {
    let path = ObjectPath::try_from(path.to_string())
        .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?;
    SignalEmitter::new(connection, path.clone())?
        .emit(
            "org.freedesktop.portal.Request",
            "Response",
            &(0u32, results),
        )
        .await?;
    Ok(path)
}

fn owned(value: Value<'_>) -> OwnedValue {
    value.try_to_owned().unwrap()
}

#[zbus::interface(name = "org.freedesktop.portal.ScreenCast")]
impl FakeScreenCast {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        5
    }

    #[zbus(property)]
    fn available_source_types(&self) -> u32 {
        7
    }

    #[zbus(property)]
    fn available_cursor_modes(&self) -> u32 {
        7
    }

    async fn create_session(
        &self,
        options: HashMap<String, OwnedValue>,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> zbus::fdo::Result<ObjectPath<'static>> {
        let request = request_path(&header, &options);
        let session_token: String = options
            .get("session_handle_token")
            .and_then(|value| value.try_clone().ok())
            .and_then(|value| String::try_from(value).ok())
            .expect("ashpd always sends a session_handle_token");
        let sender = header
            .sender()
            .unwrap()
            .trim_start_matches(':')
            .replace('.', "_");
        let session = format!("{DESKTOP_PATH}/session/{sender}/{session_token}");
        let results = HashMap::from([("session_handle".to_string(), owned(Value::from(session)))]);
        respond(connection, &request, results).await
    }

    async fn select_sources(
        &self,
        _session: ObjectPath<'_>,
        options: HashMap<String, OwnedValue>,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> zbus::fdo::Result<ObjectPath<'static>> {
        let restore_token = options
            .get("restore_token")
            .and_then(|value| value.try_clone().ok())
            .and_then(|value| String::try_from(value).ok());
        let persist_mode = options
            .get("persist_mode")
            .and_then(|value| u32::try_from(value).ok());
        self.select_calls.lock().unwrap().push(SelectCall {
            restore_token,
            persist_mode,
        });
        respond(connection, &request_path(&header, &options), HashMap::new()).await
    }

    async fn start(
        &self,
        _session: ObjectPath<'_>,
        _parent_window: String,
        options: HashMap<String, OwnedValue>,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> zbus::fdo::Result<ObjectPath<'static>> {
        let script = self.start_scripts.lock().unwrap().remove(0);
        let results = HashMap::from([
            ("streams".to_string(), owned(Value::from(script.streams))),
            (
                "restore_token".to_string(),
                owned(Value::from(script.restore_token)),
            ),
            ("persist_mode".to_string(), owned(Value::from(2u32))),
        ]);
        respond(connection, &request_path(&header, &options), results).await
    }

    fn open_pipe_wire_remote(
        &self,
        _session: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<zbus::zvariant::OwnedFd> {
        // There is no PipeWire daemon in tests; failing here proves the
        // session got past stream mapping without spawning a capture thread.
        Err(zbus::fdo::Error::Failed("no PipeWire in tests".into()))
    }
}

/// KDE "Share full Workspace": one region stream carrying only a size.
fn workspace_stream() -> (u32, StreamProps) {
    (
        142,
        HashMap::from([
            ("size".to_string(), owned(Value::from((3840i32, 1080i32)))),
            ("source_type".to_string(), owned(Value::from(1u32))),
        ]),
    )
}

/// A per-output KDE stream: position, size and connector `mapping_id`.
fn output_stream(node_id: u32, x: i32, connector: &str) -> (u32, StreamProps) {
    (
        node_id,
        HashMap::from([
            ("position".to_string(), owned(Value::from((x, 0i32)))),
            ("size".to_string(), owned(Value::from((1920i32, 1080i32)))),
            ("source_type".to_string(), owned(Value::from(1u32))),
            ("mapping_id".to_string(), owned(Value::from(connector))),
        ]),
    )
}

/// Private session bus; killed on drop. Its config lists no service
/// directories, so nothing on the host (for example the real
/// `at-spi-bus-launcher` or `xdg-desktop-portal`) can be auto-activated
/// into the test.
struct PrivateBus {
    child: Child,
    address: String,
    _dir: tempfile::TempDir,
}

const PRIVATE_BUS_CONFIG: &str = r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=DIR</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"#;

impl PrivateBus {
    fn start() -> Option<Self> {
        let dir = tempfile::tempdir().ok()?;
        let config = dir.path().join("bus.conf");
        std::fs::write(
            &config,
            PRIVATE_BUS_CONFIG.replace("DIR", &dir.path().display().to_string()),
        )
        .ok()?;
        let mut child = Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut address = String::new();
        BufReader::new(child.stdout.take()?)
            .read_line(&mut address)
            .ok()?;
        Some(Self {
            child,
            address: address.trim().to_string(),
            _dir: dir,
        })
    }
}

impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn portal_session_persists_forgets_and_presents_the_restore_token() {
    let Some(bus) = PrivateBus::start() else {
        eprintln!("skipping: dbus-daemon is not available");
        return;
    };
    let select_calls = Arc::new(Mutex::new(Vec::new()));
    let start_scripts = Arc::new(Mutex::new(vec![
        StartScript {
            streams: vec![workspace_stream()],
            restore_token: "tok-workspace",
        },
        StartScript {
            streams: vec![
                output_stream(201, 1920, "DP-2"),
                output_stream(202, 0, "DP-1"),
            ],
            restore_token: "tok-screens",
        },
    ]));
    let _portal = zbus::blocking::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .name("org.freedesktop.portal.Desktop")
        .unwrap()
        .serve_at(
            DESKTOP_PATH,
            FakeScreenCast {
                select_calls: select_calls.clone(),
                start_scripts: start_scripts.clone(),
            },
        )
        .unwrap()
        .build()
        .unwrap();

    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            CHILD_TEST,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("DBUS_SESSION_BUS_ADDRESS", &bus.address)
        .env(CHILD_ENV, "1")
        .output()
        .unwrap();
    let log = String::from_utf8_lossy(&output.stdout).to_string()
        + &String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "child session test failed:\n{log}");
    assert!(log.contains("1 passed"), "child test did not run:\n{log}");

    assert_eq!(
        *select_calls.lock().unwrap(),
        vec![
            // First boot: nothing stored yet, ask for durable persistence.
            SelectCall {
                restore_token: None,
                persist_mode: Some(PersistMode::ExplicitlyRevoked as u32),
            },
            // Next boot: the token saved on disk is presented to the portal.
            SelectCall {
                restore_token: Some("tok-seeded".into()),
                persist_mode: Some(PersistMode::ExplicitlyRevoked as u32),
            },
        ]
    );
    assert!(start_scripts.lock().unwrap().is_empty());
}

async fn drive(shared: &Arc<PortalShared>) -> Result<()> {
    let (_shutdown_tx, shutdown_rx) = watch::channel(false);
    let (_generation_tx, generation_rx) = watch::channel(1u64);
    run_portal_session(shared.clone(), 1, shutdown_rx, generation_rx).await
}

fn shared_with_two_monitors(store: &RestoreTokenStore) -> Arc<PortalShared> {
    let shared = PortalShared::with_token_store(Some(store.clone()));
    for (id, x, name) in [(1, 0, "DP-1"), (2, 1920, "DP-2")] {
        shared.monitors.lock().unwrap().insert(
            id,
            MonitorDescriptor {
                id,
                x,
                y: 0,
                width: 1920,
                height: 1080,
                name: name.to_string(),
            },
        );
    }
    Arc::new(shared)
}

#[test]
#[ignore = "spawned by portal_session_persists_forgets_and_presents_the_restore_token"]
fn child_drives_portal_sessions() {
    if std::env::var(CHILD_ENV).as_deref() != Ok("1") {
        eprintln!("refusing to run outside the fake-portal harness");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let store = RestoreTokenStore::in_dir(dir.path());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        // "Share full Workspace" is approved but unmappable: the returned
        // token is saved, then forgotten so the next attempt re-prompts.
        let shared = shared_with_two_monitors(&store);
        let error = drive(&shared).await.unwrap_err();
        assert!(
            format!("{error:#}").contains("pick individual screens"),
            "{error:#}"
        );
        assert_eq!(shared.current_restore_token(), None);
        assert_eq!(store.load(), None);

        // A later boot with a stored token: the token is presented, the
        // per-output streams map by connector, and the new token is saved.
        store.save("tok-seeded").unwrap();
        let shared = shared_with_two_monitors(&store);
        let error = drive(&shared).await.unwrap_err();
        assert!(
            format!("{error:#}").contains("failed to open portal PipeWire remote"),
            "{error:#}"
        );
        assert_eq!(
            shared.current_restore_token().as_deref(),
            Some("tok-screens")
        );
        assert_eq!(store.load().as_deref(), Some("tok-screens"));
    });
}
