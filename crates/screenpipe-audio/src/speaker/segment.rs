use anyhow::{Context, Result};
use ndarray::{ArrayBase, Axis, IxDyn, ViewRepr};
use std::{cmp::Ordering, path::Path, sync::Arc, sync::Mutex};
use tracing::error;

use super::{embedding::EmbeddingExtractor, embedding_manager::EmbeddingManager};

#[derive(Debug, Clone)]
#[repr(C)]
pub struct SpeechSegment {
    pub start: f64,
    pub end: f64,
    pub samples: Vec<f32>,
    pub speaker: String,
    pub embedding: Vec<f32>,
    pub sample_rate: u32,
}

fn find_max_index(row: ArrayBase<ViewRepr<&f32>, IxDyn>) -> Result<usize> {
    let (max_index, _) = row
        .iter()
        .enumerate()
        .max_by(|a, b| {
            a.1.partial_cmp(b.1)
                .context("Comparison error")
                .unwrap_or(Ordering::Equal)
        })
        .context("sub_row should not be empty")?;
    Ok(max_index)
}

fn create_speech_segment(
    start_offset: f64,
    offset: i32,
    sample_rate: u32,
    samples: &[f32],
    padded_samples: &[f32],
    embedding_extractor: Arc<Mutex<EmbeddingExtractor>>,
    embedding_manager: &Arc<Mutex<EmbeddingManager>>,
) -> Result<SpeechSegment> {
    let start = start_offset / sample_rate as f64;
    let end = offset as f64 / sample_rate as f64;

    let start_f64 = start * (sample_rate as f64);
    let end_f64 = end * (sample_rate as f64);

    let start_idx = start_f64.min((samples.len() - 1600) as f64) as usize;
    let mut end_idx = end_f64.min(samples.len() as f64) as usize;

    // TODO: Why is this empty sometimes?
    let mut samples = padded_samples[start_idx..end_idx].to_vec();
    // // Ensure the segment has at least 1600 samples
    let min_length = 1600;
    let segment_samples = if end_idx - start_idx < min_length {
        if end_idx + (min_length - (end_idx - start_idx)) <= samples.len() {
            // Increase the end index if possible
            end_idx += min_length - (end_idx - start_idx);
            &padded_samples[start_idx..end_idx]
        } else if start_idx >= min_length - (end_idx - start_idx) {
            // Otherwise, pad the samples.

            samples.resize(1600, 0.0);

            samples.as_slice()
        } else {
            &padded_samples[start_idx..end_idx]
        }
    } else {
        &padded_samples[start_idx..end_idx]
    };

    let embedding = match get_speaker_embedding(embedding_extractor, segment_samples) {
        Ok(embedding) => embedding,
        Err(e) => {
            error!(
                "Failed to compute speaker embedding, skipping segment: {}",
                e
            );
            return Err(anyhow::anyhow!(
                "speaker embedding extraction failed: {}",
                e
            ));
        }
    };
    let speaker = {
        let mut manager = embedding_manager.lock().unwrap();
        get_speaker_from_embedding(&mut manager, embedding.clone())
    };

    Ok(SpeechSegment {
        start,
        end,
        samples: segment_samples.to_vec(),
        speaker,
        embedding,
        sample_rate,
    })
}

fn handle_new_segment(
    current_segment: Option<SpeechSegment>,
    new_segment: SpeechSegment,
    segments: &mut Vec<SpeechSegment>,
) -> Option<SpeechSegment> {
    if let Some(mut prev_segment) = current_segment {
        if prev_segment.speaker == new_segment.speaker {
            // Merge segments
            prev_segment.end = new_segment.end;
            prev_segment.samples.extend(new_segment.samples);
            Some(prev_segment)
        } else {
            // Different speaker, push previous and start new
            segments.push(prev_segment);
            Some(new_segment)
        }
    } else {
        Some(new_segment)
    }
}

pub struct SegmentIterator {
    samples: Vec<f32>,
    sample_rate: u32,
    session: ort::Session,
    embedding_extractor: Arc<Mutex<EmbeddingExtractor>>,
    embedding_manager: Arc<Mutex<EmbeddingManager>>,
    current_position: usize,
    frame_size: i32,
    window_size: usize,
    is_speeching: bool,
    offset: i32,
    start_offset: f64,
    current_segment: Option<SpeechSegment>,
    padded_samples: Vec<f32>,
}

impl SegmentIterator {
    pub fn new<P: AsRef<Path>>(
        samples: Vec<f32>,
        sample_rate: u32,
        model_path: P,
        embedding_extractor: Arc<Mutex<EmbeddingExtractor>>,
        embedding_manager: Arc<Mutex<EmbeddingManager>>,
    ) -> Result<Self> {
        let session = super::create_session(model_path.as_ref())?;
        let window_size = (sample_rate * 10) as usize;

        let padded_samples = {
            let mut padded = samples.clone();
            padded.extend(vec![0.0; window_size - (samples.len() % window_size)]);
            padded
        };

        Ok(Self {
            samples,
            sample_rate,
            session,
            embedding_extractor,
            embedding_manager,
            current_position: 0,
            frame_size: 270,
            window_size,
            is_speeching: false,
            offset: 721, // frame_start
            start_offset: 0.0,
            current_segment: None,
            padded_samples,
        })
    }

    fn process_window(&mut self, window: &[f32]) -> Result<Option<SpeechSegment>> {
        let array = ndarray::Array1::from_vec(window.to_vec());
        let array = array
            .view()
            .insert_axis(Axis(0))
            .insert_axis(Axis(1))
            .to_owned();

        let inputs = ort::inputs![array].context("Failed to prepare inputs")?;
        let ort_outs = self
            .session
            .run(inputs)
            .context("Failed to run the session")?;
        let ort_out = ort_outs.get("output").context("Output tensor not found")?;

        let ort_out = ort_out
            .try_extract_tensor::<f32>()
            .context("Failed to extract tensor")?;

        let mut result = None;

        for row in ort_out.outer_iter() {
            for sub_row in row.axis_iter(Axis(0)) {
                let max_index = find_max_index(sub_row)?;

                if max_index != 0 {
                    if !self.is_speeching {
                        self.start_offset = self.offset as f64;
                        self.is_speeching = true;
                    }
                } else if self.is_speeching {
                    let new_segment = match create_speech_segment(
                        self.start_offset,
                        self.offset,
                        self.sample_rate,
                        &self.samples,
                        &self.padded_samples,
                        self.embedding_extractor.clone(),
                        &self.embedding_manager,
                    ) {
                        Ok(segment) => segment,
                        Err(_) => {
                            // Skip this segment (e.g. embedding extraction failed)
                            self.is_speeching = false;
                            self.offset += self.frame_size;
                            continue;
                        }
                    };

                    let mut segments = Vec::new();
                    self.current_segment =
                        handle_new_segment(self.current_segment.take(), new_segment, &mut segments);

                    if !segments.is_empty() {
                        result = segments.pop();
                    }

                    self.is_speeching = false;
                }
                self.offset += self.frame_size;
            }
        }

        Ok(result)
    }
}

impl Iterator for SegmentIterator {
    type Item = Result<SpeechSegment>;

    fn next(&mut self) -> Option<Self::Item> {
        let mut result = None;

        while self.current_position < self.padded_samples.len() - 1 {
            let end = (self.current_position + self.window_size).min(self.padded_samples.len());

            let window = if end == self.padded_samples.len() {
                self.padded_samples[self.current_position..].to_vec()
            } else {
                self.padded_samples[self.current_position..end].to_vec()
            };

            // Process the window
            match self.process_window(&window) {
                Ok(Some(segment)) => {
                    result = Some(Ok(segment));
                }
                Ok(None) => {}
                Err(e) => {
                    result = Some(Err(e));
                    break;
                }
            }

            // Update current_position after processing the window
            self.current_position += self.window_size;
        }

        // If a segment was found, return it
        if let Some(segment) = result {
            return Some(segment);
        }

        // Return final segment if exists
        if let Some(last_segment) = self.current_segment.take() {
            return Some(Ok(last_segment));
        }

        None
    }
}

pub fn get_segments<P: AsRef<Path>>(
    samples: &[f32],
    sample_rate: u32,
    model_path: P,
    embedding_extractor: Arc<Mutex<EmbeddingExtractor>>,
    embedding_manager: Arc<Mutex<EmbeddingManager>>,
) -> Result<SegmentIterator> {
    SegmentIterator::new(
        samples.to_vec(),
        sample_rate,
        model_path,
        embedding_extractor,
        embedding_manager,
    )
}

fn get_speaker_embedding(
    embedding_extractor: Arc<Mutex<EmbeddingExtractor>>,
    samples: &[f32],
) -> Result<Vec<f32>> {
    match embedding_extractor.lock().unwrap().compute(samples) {
        Ok(embedding) => Ok(embedding.collect::<Vec<f32>>()),
        Err(e) => Err(e),
    }
}

pub fn get_speaker_from_embedding(
    embedding_manager: &mut EmbeddingManager,
    embedding: Vec<f32>,
) -> String {
    let search_threshold = 0.45; // cosine similarity threshold (1 - distance), aligned with DB threshold of 0.55 distance

    embedding_manager
        .search_speaker(embedding.clone(), search_threshold)
        .ok_or_else(|| embedding_manager.search_speaker(embedding, 0.0)) // Ensure always to return speaker
        .map(|r| r.to_string())
        .unwrap_or("?".into())
}
