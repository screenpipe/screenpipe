use crate::cli::audio::CliAudioTranscriptionEngine;
use crate::cli::ocr::CliOcrEngine;
use chrono::{DateTime, Utc};
use clap::{Args, Parser, Subcommand, ValueEnum};
use is_terminal::IsTerminal;
use screenpipe_audio::{
    audio_manager::{AudioManagerBuilder, AudioManagerOptions},
    core::engine::AudioTranscriptionEngine as CoreAudioTranscriptionEngine,
    vad::{VadEngineEnum, VadSensitivity},
};
use screenpipe_core::Language;
use screenpipe_db::{
    ContentType, CustomOcrConfig as DBCustomOcrConfig, DatabaseManager, OcrEngine as DBOcrEngine,
    Order, SearchResult,
};
use screenpipe_vision::{
    custom_ocr::CustomOcrConfig, monitor::list_monitors, utils::OcrEngine as CoreOcrEngine,
    ActivityFeedOption, PipelineMetrics,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::runtime::Handle;
use tokio::signal;
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(name = "screenpipe")]
#[command(author, version, about = "AI that knows everything you've seen, said, or heard", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    #[arg(short, long, global = true, help = "Output in JSON format")]
    pub json: bool,

    #[arg(long, global = true, help = "Data directory")]
    pub data_dir: Option<PathBuf>,

    #[arg(short, long, global = true, help = "Enable debug logging")]
    pub debug: bool,

    #[arg(short, long, global = true, default_value_t = 3030, help = "Port for the control server")]
    pub port: u16,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Start recording screen and audio (shorthand for record + server)
    Run {
        #[arg(long, help = "Disable vision recording")]
        vision_disabled: bool,
        #[arg(long, help = "Disable audio recording")]
        audio_disabled: bool,
    },
    /// Record screen and audio
    Record(RecordArgs),
    /// Search through recorded data
    Search(SearchArgs),
    /// Start the control server
    Server {
        #[arg(short, long, default_value = "127.0.0.1:3030", help = "Server address")]
        addr: String,
    },
    /// Pipe data to other tools
    Pipe {
        #[arg(short, long, help = "Input data or command for the pipe")]
        input: String,
    },
}

#[derive(Args, Clone, Debug)]
pub struct RecordArgs {
    #[arg(long, help = "Duration to record in seconds")]
    pub duration: Option<u64>,
    #[arg(long, help = "Disable vision recording")]
    pub vision_disabled: bool,
    #[arg(long, help = "Disable audio recording")]
    pub audio_disabled: bool,
}

#[derive(Args, Clone, Debug)]
pub struct SearchArgs {
    #[arg(short, long, help = "Search query")]
    pub query: String,
    #[arg(short, long, value_enum, default_value = "all", help = "Content type to search")]
    pub content_type: CliContentType,
    #[arg(short, long, default_value_t = 20, help = "Limit the number of results")]
    pub limit: u32,
    #[arg(short, long, default_value_t = 0, help = "Offset the results")]
    pub offset: u32,
}

#[derive(Clone, Debug, ValueEnum)]
pub enum CliContentType {
    All,
    Vision,
    Audio,
    Input,
}

impl From<CliContentType> for ContentType {
    fn from(c: CliContentType) -> Self {
        match c {
            CliContentType::All => ContentType::All,
            CliContentType::Vision => ContentType::Vision,
            CliContentType::Audio => ContentType::Audio,
            CliContentType::Input => ContentType::Input,
        }
    }
}

pub async fn handle_search(
    db: Arc<DatabaseManager>,
    args: SearchArgs,
    json_mode: bool,
) -> anyhow::Result<()> {
    let results = db
        .search(
            &args.query,
            args.content_type.into(),
            args.limit,
            args.offset,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await?;

    let use_json = json_mode || !std::io::stdout().is_terminal();

    if use_json {
        for res in &results {
            let json = match res {
                SearchResult::OCR(r) => serde_json::to_string(r)?,
                SearchResult::Audio(r) => serde_json::to_string(r)?,
                SearchResult::UI(r) => serde_json::to_string(r)?,
                SearchResult::Input(r) => serde_json::to_string(r)?,
            };
            println!("{}", json);
        }
    } else {
        for (i, res) in results.iter().enumerate() {
            println!("[{}] {:?}", i, res);
        }
    }
    Ok(())
}

pub async fn handle_run(
    vision_disabled: bool,
    audio_disabled: bool,
    local_data_dir: PathBuf,
) -> anyhow::Result<()> {
    let token = CancellationToken::new();
    let db = Arc::new(
        DatabaseManager::new(&format!("{}/db.sqlite", local_data_dir.to_string_lossy()))
            .await?,
    );

    let output_path = Arc::new(local_data_dir.join("data").to_string_lossy().into_owned());
    let vision_metrics = Arc::new(PipelineMetrics::new());

    let mut vision_handle = None;
    if !vision_disabled {
        let db_vision = Arc::clone(&db);
        let output_path_vision = Arc::clone(&output_path);
        let vision_metrics_clone = Arc::clone(&vision_metrics);
        let token_vision = token.clone();

        vision_handle = Some(tokio::spawn(async move {
            let monitor_ids = list_monitors()
                .await
                .iter()
                .map(|m| m.id())
                .collect::<Vec<_>>();

            tokio::select! {
                _ = token_vision.cancelled() => {
                    tracing::info!("Vision task received cancellation");
                }
                res = crate::core::start_continuous_recording(
                    db_vision,
                    output_path_vision,
                    1.0,
                    Duration::from_secs(60),
                    Arc::new(CoreOcrEngine::default().into()),
                    monitor_ids,
                    false,
                    false,
                    &Handle::current(),
                    &[],
                    &[],
                    &[],
                    vec![],
                    true,
                    false,
                    ActivityFeedOption::default(),
                    "medium".to_string(),
                    vision_metrics_clone,
                ) => {
                    if let Err(e) = res {
                        tracing::error!("Vision task failed: {}", e);
                        return Err(e);
                    }
                }
            }
            Ok::<(), anyhow::Error>(())
        }));
    }

    let mut audio_handle = None;
    if !audio_disabled {
        let db_audio = Arc::clone(&db);
        let output_path_audio = PathBuf::from(output_path.as_ref());
        let token_audio = token.clone();

        audio_handle = Some(tokio::spawn(async move {
            let mut audio_manager_builder = AudioManagerBuilder::new()
                .output_path(output_path_audio)
                .transcription_engine((*CoreAudioTranscriptionEngine::default()).into());

            if let Ok(audio_manager) = audio_manager_builder.build(db_audio).await {
                tokio::select! {
                    _ = token_audio.cancelled() => {
                        tracing::info!("Audio task received cancellation");
                    }
                    res = audio_manager.start() => {
                        if let Err(e) = res {
                            tracing::error!("Audio task failed: {}", e);
                            return Err(e.into());
                        }
                    }
                }
            }
            Ok::<(), anyhow::Error>(())
        }));
    }

    let db_server = Arc::clone(&db);
    let local_data_dir_server = local_data_dir.clone();
    let output_path_server = output_path.clone();
    let token_server = token.clone();

    let server_handle = tokio::spawn(async move {
        let mut audio_manager_builder = AudioManagerBuilder::new()
            .output_path(PathBuf::from(output_path_server.as_ref()))
            .transcription_engine((*CoreAudioTranscriptionEngine::default()).into());
        
        if let Ok(audio_manager) = audio_manager_builder.build(db_server.clone()).await {
            let audio_manager = Arc::new(audio_manager);
            let server = crate::server::SCServer::new(
                db_server,
                "127.0.0.1:3030".parse().unwrap(),
                local_data_dir_server,
                vision_disabled,
                audio_disabled,
                audio_manager,
                false,
                "medium".to_string(),
            );
            
            tokio::select! {
                _ = token_server.cancelled() => {
                    tracing::info!("Server task received cancellation");
                }
                res = server.start(true) => {
                    if let Err(e) = res {
                        tracing::error!("Server task failed: {}", e);
                        return Err(e.into());
                    }
                }
            }
        }
        Ok::<(), anyhow::Error>(())
    });

    let ctrl_c = signal::ctrl_c();
    #[cfg(unix)]
    let mut sigterm = signal::unix::signal(signal::unix::SignalKind::terminate())?;

    loop {
        tokio::select! {
            _ = ctrl_c => {
                tracing::info!("Received SIGINT, shutting down...");
                token.cancel();
                break;
            }
            #[cfg(unix)]
            res = sigterm.recv() => {
                if res.is_some() {
                    tracing::info!("Received SIGTERM, shutting down...");
                    token.cancel();
                    break;
                }
            }
            res = async {
                if let Some(ref mut h) = vision_handle {
                    h.await
                } else {
                    futures::future::pending().await
                }
            } => {
                tracing::error!("Vision task exited prematurely: {:?}", res);
                token.cancel();
                break;
            }
            res = async {
                if let Some(ref mut h) = audio_handle {
                    h.await
                } else {
                    futures::future::pending().await
                }
            } => {
                tracing::error!("Audio task exited prematurely: {:?}", res);
                token.cancel();
                break;
            }
            res = server_handle => {
                tracing::error!("Server task exited prematurely: {:?}", res);
                token.cancel();
                break;
            }
        }
    }

    // Wait for tasks to finish
    if let Some(h) = vision_handle { let _ = h.await; }
    if let Some(h) = audio_handle { let _ = h.await; }
    let _ = server_handle.await;

    tracing::info!("Checkpointing database...");
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE);")
        .execute(&db.pool)
        .await;

    Ok(())
}
