// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use anyhow::{anyhow, Result};
use std::path::Path;

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let config_dir = args.next().ok_or_else(|| anyhow!("missing config dir"))?;
    let bun = args.next().ok_or_else(|| anyhow!("missing Bun path"))?;
    if args.next().is_some() {
        return Err(anyhow!("unexpected extra arguments"));
    }
    screenpipe_core::agents::pi::ensure_pi_startup_settings(
        Path::new(&config_dir),
        &bun.to_string_lossy(),
    )
}
