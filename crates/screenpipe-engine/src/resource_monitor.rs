use chrono::Local;
use reqwest::Client;
use serde_json::json;
use serde_json::Value;
use std::env;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};
use sysinfo::{PidExt, ProcessExt, System, SystemExt};
use tracing::debug;
use tracing::trace;
use tracing::{error, info, warn};

pub struct ResourceMonitor {
    start_time: Instant,
    resource_log_file: Option<String>, // analyse output here: https://colab.research.google.com/drive/1zELlGdzGdjChWKikSqZTHekm5XRxY-1r?usp=sharing
    posthog_client: Option<Client>,
    posthog_enabled: bool,
    distinct_id: String,
}

pub enum RestartSignal {
    RecordingTasks,
}

impl ResourceMonitor {
    pub fn new(telemetry_enabled: bool) -> Arc<Self> {
        let resource_log_file = if env::var("SAVE_RESOURCE_USAGE").is_ok() {
            let now = Local::now();
            let filename = format!("resource_usage_{}.json", now.format("%Y%m%d_%H%M%S"));
            info!("Resource usage data will be saved to file: {}", filename);

            // Initialize the file with an empty JSON array
            if let Ok(mut file) = File::create(&filename) {
                if let Err(e) = file.write_all(b"[]") {
                    error!("Failed to initialize JSON file: {}", e);
                }
            } else {
                error!("Failed to create JSON file: {}", filename);
            }

            Some(filename)
        } else {
            None
        };

        // Create client once and reuse instead of Option
        let posthog_client = telemetry_enabled.then(Client::new);

        if telemetry_enabled {
            debug!("Telemetry enabled, will send performance data to PostHog");
        } else {
            debug!("Telemetry disabled, will not send performance data to PostHog");
        }

        // Use analytics ID from env var (passed from Tauri app) or generate random UUID
        let distinct_id = env::var("SCREENPIPE_ANALYTICS_ID")
            .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());

        Arc::new(Self {
            start_time: Instant::now(),
            resource_log_file,
            posthog_client,
            posthog_enabled: telemetry_enabled,
            distinct_id,
        })
    }

    async fn send_to_posthog(
        &self,
        total_memory_gb: f64,
        system_total_memory: f64,
        total_cpu: f32,
    ) {
        let Some(client) = &self.posthog_client else {
            return;
        };

        // Create System only when needed
        let sys = System::new();

        // Avoid unnecessary cloning by using references
        let payload = json!({
            "api_key": "phc_Bt8GoTBPgkCpDrbaIZzJIEYt0CrJjhBiuLaBck1clce",
            "event": "resource_usage",
            "properties": {
                "distinct_id": &self.distinct_id,
                "$lib": "rust-reqwest",
                "total_memory_gb": total_memory_gb,
                "system_total_memory_gb": system_total_memory,
                "memory_usage_percent": (total_memory_gb / system_total_memory) * 100.0,
                "total_cpu_percent": total_cpu,
                "runtime_seconds": self.start_time.elapsed().as_secs(),
                "os_name": sys.name().unwrap_or_default(),
                "os_version": sys.os_version().unwrap_or_default(),
                "kernel_version": sys.kernel_version().unwrap_or_default(),
                "cpu_count": sys.cpus().len(),
                "release": env!("CARGO_PKG_VERSION"),
            }
        });

        trace!(target: "resource_monitor", "Sending resource usage to PostHog: {:?}", payload);

        // Send the event to PostHog
        if let Err(e) = client
            .post("https://eu.i.posthog.com/capture/")
            .json(&payload)
            .send()
            .await
        {
            error!("Failed to send resource usage to PostHog: {}", e);
        }
    }

    async fn collect_metrics(&self, sys: &System) -> (f64, f64, f64, f32, f64, Duration) {
        let pid = std::process::id();
        let mut total_memory = 0.0;
        let mut max_virtual_memory = 0.0; // Changed from total to max
        let mut total_cpu = 0.0;

        if let Some(main_process) = sys.process(sysinfo::Pid::from_u32(pid)) {
            total_memory += main_process.memory() as f64 / (1024.0 * 1024.0 * 1024.0);

            // Take the maximum virtual memory instead of sum
            max_virtual_memory = main_process.virtual_memory() as f64 / (1024.0 * 1024.0 * 1024.0);

            total_cpu += main_process.cpu_usage();

            // Add child processes
            for child_process in sys.processes().values() {
                if child_process.parent() == Some(sysinfo::Pid::from_u32(pid)) {
                    total_memory += child_process.memory() as f64 / (1024.0 * 1024.0 * 1024.0);

                    // Take max instead of sum
                    max_virtual_memory = max_virtual_memory
                        .max(child_process.virtual_memory() as f64 / (1024.0 * 1024.0 * 1024.0));

                    total_cpu += child_process.cpu_usage();
                }
            }
        }

        let system_total_memory = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
        let memory_usage_percent = (total_memory / system_total_memory) * 100.0;
        let runtime = self.start_time.elapsed();

        (
            total_memory,
            system_total_memory,
            memory_usage_percent,
            total_cpu,
            max_virtual_memory,
            runtime,
        )
    }

    async fn log_to_file(&self, metrics: (f64, f64, f64, f32, f64, Duration)) {
        let (
            total_memory_gb,
            system_total_memory,
            memory_usage_percent,
            total_cpu,
            total_virtual_memory_gb,
            runtime,
        ) = metrics;

        if let Some(ref filename) = self.resource_log_file {
            let json_data = json!({
                "timestamp": Local::now().to_rfc3339(),
                "runtime_seconds": runtime.as_secs(),
                "total_memory_gb": total_memory_gb,
                "system_total_memory_gb": system_total_memory,
                "memory_usage_percent": memory_usage_percent,
                "total_cpu_percent": total_cpu,
                "total_virtual_memory_gb": total_virtual_memory_gb,
            });

            if let Ok(mut file) = OpenOptions::new().read(true).write(true).open(filename) {
                let mut contents = String::new();
                if file.read_to_string(&mut contents).is_ok() {
                    if let Ok(mut json_array) = serde_json::from_str::<Value>(&contents) {
                        if let Some(array) = json_array.as_array_mut() {
                            array.push(json_data);
                            if file.set_len(0).is_ok() && file.seek(SeekFrom::Start(0)).is_ok() {
                                if let Err(e) = file.write_all(json_array.to_string().as_bytes()) {
                                    error!("Failed to write JSON data to file: {}", e);
                                }
                            }
                        }
                    }
                }
                let _ = file.flush();
            }
        }
    }

    async fn log_status(&self, sys: &System) {
        let metrics = self.collect_metrics(sys).await;
        let (
            total_memory_gb,
            system_total_memory,
            memory_usage_percent,
            total_cpu,
            total_virtual_memory_gb,
            runtime,
        ) = metrics;

        // Log to console with virtual memory
        let log_message = format!(
            "Runtime: {}s, Memory: {:.0}% ({:.2} GB / {:.2} GB), Virtual: {:.2} GB, CPU: {:.0}%",
            runtime.as_secs(),
            memory_usage_percent,
            total_memory_gb,
            system_total_memory,
            total_virtual_memory_gb,
            total_cpu
        );
        debug!("{}", log_message);

        // Log to file
        self.log_to_file(metrics).await;

        // Send to PostHog if enabled
        if self.posthog_enabled {
            tokio::select! {
                _ = self.send_to_posthog(total_memory_gb, system_total_memory, total_cpu) => {},
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    warn!("PostHog request timed out");
                }
            }
        }
    }

    pub fn start_monitoring(
        self: &Arc<Self>,
        interval: Duration,
        posthog_interval: Option<Duration>,
    ) {
        let monitor = Arc::clone(self);
        let posthog_interval = posthog_interval.unwrap_or(interval);
        let mut last_posthog_update = Instant::now();

        tokio::spawn(async move {
            let mut sys = System::new_all();

            loop {
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {
                        sys.refresh_all();
                        let now = Instant::now();
                        let should_send_to_posthog = now.duration_since(last_posthog_update) >= posthog_interval;

                        if should_send_to_posthog {
                            last_posthog_update = now;
                            monitor.log_status(&sys).await;
                        } else {
                            // Log status without sending to PostHog
                            monitor.log_status_local(&sys).await;
                        }
                    }
                }
            }
        });
    }

    // New method for logging without PostHog
    async fn log_status_local(&self, sys: &System) {
        let metrics = self.collect_metrics(sys).await;
        let (
            total_memory_gb,
            system_total_memory,
            memory_usage_percent,
            total_cpu,
            total_virtual_memory_gb,
            runtime,
        ) = metrics;

        // Log to console with virtual memory
        let log_message = format!(
            "Runtime: {}s, Memory: {:.0}% ({:.2} GB / {:.2} GB), Virtual: {:.2} GB, CPU: {:.0}%",
            runtime.as_secs(),
            memory_usage_percent,
            total_memory_gb,
            system_total_memory,
            total_virtual_memory_gb,
            total_cpu
        );
        debug!("{}", log_message);

        // Log to file
        self.log_to_file(metrics).await;
    }

    pub async fn shutdown(&self) {
        if let Some(ref file) = self.resource_log_file {
            if let Ok(mut f) = OpenOptions::new().write(true).open(file) {
                let _ = f.flush();
            }
        }

        if self.posthog_client.is_some() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
