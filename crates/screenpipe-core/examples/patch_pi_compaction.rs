// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Apply the production patcher to the runtime eval's disposable Pi install.

fn main() -> anyhow::Result<()> {
    let install_dir = std::env::args_os()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("expected a disposable Pi install directory"))?;
    screenpipe_core::agents::pi_compaction::ensure(std::path::Path::new(&install_dir))
}
