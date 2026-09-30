// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use anyhow::{Context, Result};
use ndarray::Array2;
use std::path::Path;

/// knf-rs computes fbank features with a 25 ms analysis window, which is 400
/// samples at the 16 kHz the embedder runs at. Given fewer samples than one
/// full window it produces zero frames and then panics on an internal
/// `Option::unwrap` inside `OnlineGenericBaseFeature::InputFinished` — the
/// `compute_fbank failed` crash (SCREENPIPE-CLI-3S, recurring in Sentry).
/// We reject sub-window input up front so the segment is skipped cleanly
/// instead of unwinding the audio worker and logging a panic.
const MIN_FBANK_SAMPLES: usize = 400;

/// True when `num_samples` is too short for knf-rs to yield even one fbank
/// frame (and would therefore panic). Pulled out as a free function so the
/// threshold contract is unit-testable without loading the ONNX model.
#[inline]
fn fbank_input_too_short(num_samples: usize) -> bool {
    num_samples < MIN_FBANK_SAMPLES
}

#[derive(Debug)]
pub struct EmbeddingExtractor {
    session: ort::session::Session,
    // Output node name of the embedding model, resolved once at load time.
    // Canonical exports name it "embs"; see `super::resolve_output_name`.
    output_name: String,
}

impl EmbeddingExtractor {
    pub fn new<P: AsRef<Path>>(model_path: P) -> Result<Self> {
        let session = super::create_embedding_session(&model_path)?;
        let output_name =
            super::resolve_output_name(&super::session_output_names(&session), "embs")?;
        Ok(Self {
            session,
            output_name,
        })
    }
    pub fn compute(&mut self, samples: &[f32]) -> Result<impl Iterator<Item = f32>> {
        // Sub-window input makes knf-rs panic (see MIN_FBANK_SAMPLES). Reject it
        // before calling in so we skip the segment cleanly rather than relying
        // on the catch_panic guard below to unwind a panic on the hot path.
        if fbank_input_too_short(samples.len()) {
            anyhow::bail!(
                "audio too short for speaker embedding: {} samples (< {} = one 25ms fbank window @ 16kHz)",
                samples.len(),
                MIN_FBANK_SAMPLES
            );
        }
        // knf-rs exposes ndarray 0.16 types; the workspace is on 0.17 for
        // ort rc.12 — rebuild the array in our ndarray version via raw parts.
        //
        // knf-rs also *panics* (Option::unwrap on None deep in
        // OnlineGenericBaseFeature::InputFinished) when `samples` is too short
        // to yield an fbank frame, unwinding the audio worker instead of
        // returning an error — the highest-volume crash in the field
        // (SCREENPIPE-CLI-3S). Run it under the same panic guard create_session
        // uses so the caller skips the segment gracefully (see get_speaker_embedding).
        let features_016 = super::catch_panic_into_error("compute_fbank", || {
            knf_rs::compute_fbank(samples)
                .map_err(anyhow::Error::msg)
                .context("compute_fbank failed")
        })?;
        let (rows, cols) = features_016.dim();
        let features: Array2<f32> =
            Array2::from_shape_vec((rows, cols), features_016.into_raw_vec_and_offset().0)
                .context("fbank shape roundtrip failed")?;
        let features = features.insert_axis(ndarray::Axis(0)); // Add batch dimension
        let inputs = ort::inputs!["feats" => ort::value::TensorRef::from_array_view(&features)
            .map_err(|e| anyhow::anyhow!("ort: {e}"))?];

        let ort_outs = self
            .session
            .run(inputs)
            .map_err(|e| anyhow::anyhow!("ort: {e}"))?;
        let ort_out = ort_outs
            .get(&self.output_name)
            .context("Output tensor not found")?
            .try_extract_array::<f32>()
            .context("Failed to extract tensor")?;

        // Collect the tensor data into a Vec to own it
        let embeddings: Vec<f32> = ort_out.iter().copied().collect();

        // Return an iterator over the Vec
        Ok(embeddings.into_iter())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn real_model_and_audio() -> Result<(std::path::PathBuf, Vec<f32>)> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let model = root.join("models/pyannote/wespeaker_en_voxceleb_CAM++.onnx");
        let (audio, sample_rate) = crate::pcm_decode(&root.join("test_data/accuracy1.wav"))?;
        let audio = if sample_rate == 16_000 {
            audio
        } else {
            crate::resample(&audio, sample_rate, 16_000)?
        };
        anyhow::ensure!(
            audio.len() >= 30 * 16_000,
            "fixture must contain 30 seconds"
        );
        Ok((model, audio))
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn compatibility_extractor(model: &Path) -> Result<EmbeddingExtractor> {
        Ok(EmbeddingExtractor {
            session: crate::speaker::create_session_with_provider(
                model,
                crate::speaker::SessionKind::EmbeddingCpu,
            )?,
            output_name: "embs".to_string(),
        })
    }

    /// Exercise the macOS compatibility path even on older build hosts. The
    /// 100 ms case caught NaN vectors from the rejected MLProgram workaround.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "requires real LFS speaker model and audio fixture on Apple Silicon"]
    fn embedding_compatibility_matches_cpu_across_audio_lengths() -> Result<()> {
        let (model, audio) = real_model_and_audio()?;
        let mut compatibility = compatibility_extractor(&model)?;
        let mut cpu = EmbeddingExtractor {
            session: crate::speaker::create_session(&model)?,
            output_name: "embs".to_string(),
        };
        for samples in [1_600, 16_000, 80_000, 320_000, 480_000] {
            let actual: Vec<_> = compatibility.compute(&audio[..samples])?.collect();
            let expected: Vec<_> = cpu.compute(&audio[..samples])?.collect();
            assert_eq!(actual.len(), expected.len());
            assert!(!actual.is_empty());
            assert!(
                actual.iter().chain(&expected).all(|x| x.is_finite()),
                "samples={samples}: finite compatibility={}/{}, reference={}/{}",
                actual.iter().filter(|x| x.is_finite()).count(),
                actual.len(),
                expected.iter().filter(|x| x.is_finite()).count(),
                expected.len()
            );
            let dot: f32 = actual.iter().zip(&expected).map(|(a, b)| a * b).sum();
            let norm = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>().sqrt();
            let cosine = dot / (norm(&actual) * norm(&expected));
            eprintln!("speaker embedding samples={samples} cosine_to_cpu={cosine}");
            assert!(cosine > 0.999, "speaker vector changed: {cosine}");
        }
        Ok(())
    }

    /// Bypassing CoreML must not restore the dynamic-shape native memory
    /// growth that originally required the CoreML execution provider.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "real-model repeated 248-shape physical-footprint regression on Apple Silicon"]
    fn embedding_compatibility_dynamic_shapes_memory_plateaus() -> Result<()> {
        let (model, audio) = real_model_and_audio()?;
        let mut extractor = compatibility_extractor(&model)?;
        let mut endpoints = Vec::new();
        for index in 0..(4 * 248) {
            // Repeat 248 distinct shapes to distinguish a bounded working set
            // from continued retention. Permute short and long speaker turns.
            let samples = 16_000 + (index * 73 % 248) * (29 * 16_000) / 247;
            let vector: Vec<_> = extractor.compute(&audio[..samples])?.collect();
            assert!(!vector.is_empty() && vector.iter().all(|x| x.is_finite()));
            if (index + 1) % 50 == 0 || index == 4 * 248 - 1 {
                let mut info: libc::rusage_info_v0 = unsafe { std::mem::zeroed() };
                let result = unsafe {
                    libc::proc_pid_rusage(
                        std::process::id() as libc::c_int,
                        libc::RUSAGE_INFO_V0,
                        (&mut info as *mut libc::rusage_info_v0).cast(),
                    )
                };
                assert_eq!(result, 0, "proc_pid_rusage failed");
                endpoints.push(info.ri_phys_footprint);
                eprintln!(
                    "speaker embedding calls={} physical_footprint_mib={:.1}",
                    index + 1,
                    info.ri_phys_footprint as f64 / (1024.0 * 1024.0)
                );
            }
        }
        // Same allowance as the full reconciliation regression; this isolates
        // the speaker provider without requiring the separate MLX ASR model.
        let growth = endpoints[1..]
            .iter()
            .max()
            .unwrap()
            .saturating_sub(endpoints[0]);
        assert!(
            growth <= 512 * 1024 * 1024,
            "speaker footprint grew {growth} bytes"
        );
        Ok(())
    }

    #[test]
    fn rejects_sub_window_audio_before_knf() {
        // One 25 ms window at 16 kHz is 400 samples; anything shorter is the
        // panic case we guard against, anything >= is allowed through.
        assert_eq!(MIN_FBANK_SAMPLES, 400);
        assert!(fbank_input_too_short(0));
        assert!(fbank_input_too_short(399));
        assert!(!fbank_input_too_short(400));
        assert!(!fbank_input_too_short(16_000));
    }
}
