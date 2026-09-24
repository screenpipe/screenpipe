// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Offline replay: cargo run -p screenpipe-audio --example aec_replay -- speech.f32
// Mono 16kHz little-endian f32 public speech fixture. Does not open audio devices.
use screenpipe_audio::core::aec::SonoraAecProcessor;
fn run(name: &str, source: &[f32], mode: u8, burst: usize, stamp_shift: u64) {
    let mut p = SonoraAecProcessor::new();
    let frames = source.len() / 160;
    let mut raw = 0.0_f64;
    let mut clean = 0.0_f64;
    let mut returned = 0;
    for begin in (0..frames).step_by(burst) {
        let end = (begin + burst).min(frames);
        let speaker = &source[begin * 160..end * 160];
        let mic: Vec<f32> = (begin * 160..end * 160)
            .map(|i| {
                let direct = if i >= 960 {
                    source[i - 960] * 0.55
                } else {
                    0.0
                };
                let reflection = if i >= 1280 {
                    source[i - 1280] * 0.15
                } else {
                    0.0
                };
                direct + reflection
            })
            .collect();
        let ts = 1_000_000 + begin as u64 * 10;
        if mode == 1 {
            p.push_mic(&mic, ts);
            for (m, _, t) in p.process() {
                if t >= 1_005_000 {
                    clean += m.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
                }
                returned += m.len();
            }
        }
        if mode != 2 {
            p.push_speaker(speaker, ts + stamp_shift);
        }
        if mode != 1 {
            p.push_mic(&mic, ts);
        }
        for (m, _, t) in p.process() {
            if t >= 1_005_000 {
                clean += m.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
            }
            returned += m.len();
        }
        let skip = (500usize * 160).saturating_sub(begin * 160).min(mic.len());
        raw += mic[skip..].iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
    }
    let before_finish = returned;
    for (m, _, t) in p.finish() {
        if t >= 1_005_000 {
            clean += m.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
        }
        returned += m.len();
    }
    assert_eq!(returned, frames * 160, "{name}: microphone sample loss");
    let attenuation_db = 10.0 * (raw / clean.max(1e-30)).log10();
    if mode != 2 && stamp_shift == 0 {
        assert!(
            attenuation_db > 20.0,
            "{name}: echo-only attenuation regressed: {attenuation_db:.2} dB"
        );
        assert_eq!(
            p.diagnostics().bypass_frames,
            0,
            "{name}: unexpected bypass"
        );
    }
    let d = p.diagnostics();
    println!("{name},energy_reduction_db={:.2},returned={returned},input={},shutdown_tail={},aligned={},bypass={},dropped={},underflow={}",10.0*(raw/clean.max(1e-30)).log10(),frames*160,returned-before_finish,d.aligned_frames,d.bypass_frames,d.dropped_frames,d.speaker_underflow_frames);
}
fn paired_speech(reference: &[f32], near: &[f32], mic_first: bool) -> Vec<f32> {
    let mut aec = SonoraAecProcessor::new();
    let frames = reference.len().min(near.len()) / 160;
    let mut output = Vec::new();
    for start in (0..frames).step_by(10) {
        let end = (start + 10).min(frames) * 160;
        let begin = start * 160;
        let mic: Vec<_> = (begin..end)
            .map(|i| {
                near[i] * 0.5
                    + if i >= 960 {
                        reference[i - 960] * 0.55
                    } else {
                        0.0
                    }
            })
            .collect();
        let ts = 1000 + start as u64 * 10;
        if mic_first {
            aec.push_mic(&mic, ts);
            output.extend(aec.process().into_iter().flat_map(|f| f.0));
        }
        aec.push_speaker(&reference[begin..end], ts);
        if !mic_first {
            aec.push_mic(&mic, ts);
        }
        output.extend(aec.process().into_iter().flat_map(|f| f.0));
    }
    output.extend(aec.finish().into_iter().flat_map(|f| f.0));
    assert_eq!(output.len(), frames * 160);
    output
}
fn double_talk(reference: &[f32], near: &[f32]) {
    let aligned = paired_speech(reference, near, false);
    let jittered = paired_speech(reference, near, true);
    assert_eq!(
        aligned, jittered,
        "delivery jitter must not change simultaneous local speech"
    );
    assert!(
        aligned.iter().any(|v| v.abs() > 0.01),
        "double talk must not collapse to silence"
    );
    println!(
        "double_talk_100ms_jitter,bit_exact_to_aligned=true,samples={}",
        aligned.len()
    );
}

fn main() {
    let bytes = std::fs::read(std::env::args().nth(1).unwrap()).unwrap();
    assert_eq!(bytes.len() % 4, 0, "f32 input alignment");
    let source: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    assert!(
        source.len() >= 16000 * 6 && source.iter().all(|x| x.is_finite()),
        "need finite speech >=6 seconds"
    );
    run("aligned_10ms", &source, 0, 1, 0);
    run("missing_reference_10ms", &source, 2, 1, 0);
    run("mic_first_100ms", &source, 1, 10, 0);
    run("reference_clock_500ms_ahead", &source, 0, 1, 500);
    run("aligned_1500ms_bursts", &source, 0, 150, 0);
    if let Some(path) = std::env::args().nth(2) {
        let bytes = std::fs::read(path).unwrap();
        let near: Vec<_> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        assert!(near.len() >= 16000 * 6 && near.iter().all(|x| x.is_finite()));
        double_talk(&source, &near);
    }
}
