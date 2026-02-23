#[cfg(target_os = "windows")]
use std::{env, fs};
use std::{
    io::Result,
    process::{Command, Output},
};

fn main() {
    #[cfg(target_os = "windows")]
    {
        install_onnxruntime();
    }

    #[cfg(target_os = "macos")]
    {
        setup_macos_libs();
    }

    if !is_bun_installed() {
        install_bun();
    }
}

#[cfg(target_os = "macos")]
fn homebrew_prefix() -> String {
    // Allow CI / developer override
    if let Ok(p) = std::env::var("HOMEBREW_PREFIX") {
        return p;
    }

    // Query Homebrew — handles both Apple Silicon (/opt/homebrew) and Intel (/usr/local)
    if let Ok(out) = Command::new("brew").arg("--prefix").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }

    // Static fallback based on well-known install locations
    if std::path::Path::new("/opt/homebrew").exists() {
        "/opt/homebrew".to_string()
    } else {
        "/usr/local".to_string()
    }
}

#[cfg(target_os = "macos")]
fn setup_macos_libs() {
    let prefix = homebrew_prefix();
    // Point the linker at Homebrew's lib directory for FFmpeg and other native deps
    println!("cargo:rustc-link-search=native={}/lib", prefix);
    println!("cargo:rerun-if-env-changed=HOMEBREW_PREFIX");
}

fn is_bun_installed() -> bool {
    let output = Command::new("bun").arg("--version").output();

    match output {
        Err(_) => false,
        Ok(output) => output.status.success(),
    }
}

fn run_bun_install_command(command: Result<Output>) {
    match command {
        Err(error) => {
            println!("failed to install bun: {}", error);
            println!("please install bun manually.");
        }
        Ok(output) => {
            if output.status.success() {
                println!("bun installed successfully.");
            } else {
                println!(
                    "failed to install bun: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                println!("please install bun manually.");
            }
        }
    }
}

fn install_bun() {
    println!("installing bun...");

    #[cfg(target_os = "windows")]
    {
        println!("attempting to install bun using npm...");

        run_bun_install_command(Command::new("npm").args(["install", "-g", "bun"]).output());
    }

    #[cfg(not(target_os = "windows"))]
    {
        run_bun_install_command(
            Command::new("sh")
                .args(["-c", "curl -fsSL https://bun.sh/install | bash"])
                .output(),
        );
    }
}

#[cfg(target_os = "windows")]
fn find_unzip() -> Option<std::path::PathBuf> {
    let paths = [
        // check PATH first
        which::which("unzip").ok(),
        // fallback to common GnuWin32 location
        Some(std::path::PathBuf::from(
            r"C:\Program Files (x86)\GnuWin32\bin\unzip.exe",
        )),
    ];

    paths.into_iter().flatten().find(|p| p.exists())
}

#[cfg(target_os = "windows")]
fn install_onnxruntime() {
    use reqwest::blocking::Client;
    use std::time::Duration;
    use std::{path::Path, process::Command};
    // Set static CRT for Windows MSVC target
    if env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default() == "msvc" {
        println!("cargo:rustc-env=KNF_STATIC_CRT=1");
        println!("cargo:rustc-flag=-C target-feature=+crt-static");
    }

    // Use CPU-only onnxruntime — GPU (DirectML) causes issues on Intel integrated GPUs
    let target_dir =
        Path::new("../../apps/screenpipe-app-tauri/src-tauri/onnxruntime-win-x64-1.19.2");

    // Skip download if already present (CI pre-downloads via workflow step)
    if !target_dir.join("lib").join("onnxruntime.lib").exists() {
        let url = "https://github.com/microsoft/onnxruntime/releases/download/v1.19.2/onnxruntime-win-x64-1.19.2.zip";
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("failed to build client");
        let resp = client.get(url).send().expect("request failed");
        let body = resp.bytes().expect("body invalid");
        fs::write("./onnxruntime-win-x64-1.19.2.zip", &body).expect("failed to write");
        let unzip_path = find_unzip().expect(
            "could not find unzip executable - please install it via GnuWin32 or add it to PATH",
        );

        let status = Command::new(unzip_path)
            .args(["-o", "onnxruntime-win-x64-1.19.2.zip"])
            .status()
            .expect("failed to execute unzip");

        if !status.success() {
            panic!("failed to install onnx binary");
        }
        if target_dir.exists() {
            fs::remove_dir_all(target_dir).expect("failed to remove existing directory");
        }
        fs::rename("onnxruntime-win-x64-1.19.2", target_dir).expect("failed to rename");
    }
    println!("cargo:rustc-link-search=native=../../apps/screenpipe-app-tauri/src-tauri/onnxruntime-win-x64-1.19.2/lib");
}
