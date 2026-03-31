use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use futures::pin_mut;
use screenpipe_audio::{audio_manager::AudioManagerBuilder, core::device::list_audio_devices};
use screenpipe_core::Language;
use screenpipe_db::DatabaseManager;
use tokio::signal::{self};

#[derive(Parser, Debug)]
#[clap(author, version, about, long_about = None)]
struct Args {
    #[clap(
        short,
        long,
        help = "Audio device name (can be specified multiple times)"
    )]
    audio_device: Vec<String>,

    #[clap(long, help = "List available audio devices")]
    list_audio_devices: bool,

    #[clap(long, help = "Audio chunk duration in seconds")]
    audio_chunk_duration: f32,

    #[clap(long, help = "Deepgram API key")]
    deepgram_api_key: Option<String>,

    #[clap(short = 'l', long, value_enum)]
    language: Vec<Language>,
}

fn print_devices(devices: &[String]) {
    println!("Available audio devices:");
    for device in devices.iter() {
        println!("  {}", device);
    }

    #[cfg(target_os = "macos")]
    println!("On macOS, it's not intuitive but output devices are your displays");
}

// ! usage - cargo run --bin screenpipe-audio -- --audio-device "Display 1 (output)"

#[tokio::main]
async fn main() -> Result<()> {
    use env_logger::Builder;
    use log::LevelFilter;

    Builder::new()
        .filter(None, LevelFilter::Info)
        .filter_module("tokenizers", LevelFilter::Error)
        .init();

    let args = Args::parse();

    let languages = args.language;

    let devices = list_audio_devices()
        .await?
        .iter()
        .map(|d| d.to_string())
        .collect::<Vec<String>>();

    if args.list_audio_devices {
        print_devices(&devices);
        return Ok(());
    }

    let ctrl_c_future = signal::ctrl_c();
    pin_mut!(ctrl_c_future);

    let db = DatabaseManager::new("sqlite::memory:", Default::default()).await?;

    let mut builder = AudioManagerBuilder::new()
        .languages(languages)
        .enabled_devices(args.audio_device)
        .output_path("/tmp/screenpipe".into());

    let manager = builder.build(Arc::new(db)).await?;

    manager.start().await?;

    tokio::select! {
        _ = ctrl_c_future => {
            manager.stop().await?;
        }
    }

    Ok(())
}
