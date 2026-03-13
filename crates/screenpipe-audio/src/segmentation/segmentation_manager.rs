use anyhow::{anyhow, Result};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

use tracing::warn;

use crate::speaker::{
    embedding::EmbeddingExtractor,
    embedding_manager::EmbeddingManager,
    models::{get_or_download_model, invalidate_cached_model, PyannoteModel},
};

pub struct SegmentationManager {
    pub embedding_manager: Arc<StdMutex<EmbeddingManager>>,
    pub embedding_extractor: Arc<StdMutex<EmbeddingExtractor>>,
    pub segmentation_model_path: PathBuf,
}

impl SegmentationManager {
    pub async fn new() -> Result<Self> {
        let embedding_model_path = get_or_download_model(PyannoteModel::Embedding).await?;
        let segmentation_model_path = get_or_download_model(PyannoteModel::Segmentation).await?;

        let embedding_extractor = match EmbeddingExtractor::new(
            embedding_model_path
                .to_str()
                .ok_or_else(|| anyhow!("Invalid embedding model path"))?,
        ) {
            Ok(ext) => ext,
            Err(e) => {
                warn!(
                    "failed to load embedding model (possibly corrupt), re-downloading: {}",
                    e
                );
                invalidate_cached_model(&PyannoteModel::Embedding).await?;
                let new_path = get_or_download_model(PyannoteModel::Embedding).await?;
                EmbeddingExtractor::new(
                    new_path
                        .to_str()
                        .ok_or_else(|| anyhow!("Invalid embedding model path"))?,
                )?
            }
        };
        let embedding_extractor = Arc::new(StdMutex::new(embedding_extractor));

        let embedding_manager = Arc::new(StdMutex::new(EmbeddingManager::new(usize::MAX)));
        Ok(SegmentationManager {
            embedding_manager,
            embedding_extractor,
            segmentation_model_path,
        })
    }
}
