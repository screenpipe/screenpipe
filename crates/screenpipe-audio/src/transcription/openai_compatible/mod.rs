pub mod batch;

use lazy_static::lazy_static;
use std::env;

lazy_static! {
    pub(crate) static ref OPENAI_COMPATIBLE_DEFAULT_URL: String = env::var("OPENAI_COMPATIBLE_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8080".to_string());
}
