// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Run the production image-PII detector over a folder of frames and write
//! one JSON line per frame (regions + wall time). Read-only on the inputs.
//!
//! ```bash
//! cargo run -p screenpipe-redact --example realscreen_detect \
//!     --features onnx-cpu --release -- <model.onnx> <images_dir> <out.jsonl> <conf>
//! ```

use std::io::Write;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use screenpipe_redact::adapters::rfdetr::{RfdetrConfig, RfdetrRedactor};
    use screenpipe_redact::image::ImageRedactor;

    let mut args = std::env::args().skip(1);
    let usage = "usage: <model.onnx> <images_dir> <out.jsonl> <conf>";
    let model = PathBuf::from(args.next().expect(usage));
    let dir = PathBuf::from(args.next().expect(usage));
    let out = PathBuf::from(args.next().expect(usage));
    let conf: f32 = args.next().expect(usage).parse()?;

    let redactor = RfdetrRedactor::load(RfdetrConfig {
        model_path: model,
        input_size: 0,
        conf_threshold: conf,
        tiled_inference: true,
        extend_wrapped_secrets: true,
    })?;

    let mut frames: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jpg" || x == "png"))
        .collect();
    frames.sort();

    let mut file = std::fs::File::create(&out)?;
    for (i, frame) in frames.iter().enumerate() {
        let id = frame.file_stem().unwrap_or_default().to_string_lossy();
        let start = std::time::Instant::now();
        let result = redactor.detect(frame).await;
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(regions) => {
                let items: Vec<String> = regions
                    .iter()
                    .map(|r| {
                        format!(
                            "{{\"label\":\"{}\",\"score\":{:.4},\"bbox\":[{},{},{},{}]}}",
                            format!("{:?}", r.label).to_lowercase(),
                            r.score,
                            r.bbox[0],
                            r.bbox[1],
                            r.bbox[2],
                            r.bbox[3]
                        )
                    })
                    .collect();
                writeln!(
                    file,
                    "{{\"id\":\"{}\",\"status\":\"ok\",\"ms\":{:.1},\"regions\":[{}]}}",
                    id,
                    ms,
                    items.join(",")
                )?;
            }
            Err(err) => {
                let msg = format!("{err}").replace(['"', '\\', '\n'], " ");
                writeln!(
                    file,
                    "{{\"id\":\"{id}\",\"status\":\"error\",\"ms\":{ms:.1},\"error\":\"{msg}\"}}"
                )?;
            }
        }
        if i % 50 == 0 {
            eprintln!("{}/{}", i + 1, frames.len());
        }
    }
    Ok(())
}
