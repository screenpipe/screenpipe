use std::process::Command;

fn main() {
    // Set up native library search paths for macOS (Apple Silicon and Intel)
    #[cfg(target_os = "macos")]
    setup_macos_libs();
}

#[cfg(target_os = "macos")]
fn setup_macos_libs() {
    let prefix = homebrew_prefix();
    println!("cargo:rustc-link-search=native={}/lib", prefix);
    println!("cargo:rerun-if-env-changed=HOMEBREW_PREFIX");
}

#[cfg(target_os = "macos")]
fn homebrew_prefix() -> String {
    // Allow CI / developer override via environment variable
    if let Ok(p) = std::env::var("HOMEBREW_PREFIX") {
        return p;
    }

    // Ask Homebrew directly — works for both Apple Silicon and Intel installs
    if let Ok(out) = Command::new("brew").arg("--prefix").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }

    // Static fallback: Apple Silicon → /opt/homebrew, Intel → /usr/local
    if std::path::Path::new("/opt/homebrew").exists() {
        "/opt/homebrew".to_string()
    } else {
        "/usr/local".to_string()
    }
}
