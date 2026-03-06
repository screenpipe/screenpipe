#[cfg(target_os = "windows")]
use std::env;
#[cfg(target_os = "windows")]
use std::fs;
use std::{
    io::Result,
    process::{Command, Output},
};

fn main() {
    #[cfg(target_os = "windows")]
    {
        install_onnxruntime();
    }

    if !is_bun_installed() {
        install_bun();
    }
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

    // Detect target architecture for correct ONNX Runtime variant
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "x86_64".to_string());
    let (arch_suffix, dir_name) = match target_arch.as_str() {
        "aarch64" => ("arm64", "onnxruntime-win-arm64-1.19.2"),
        _ => ("x64", "onnxruntime-win-x64-1.19.2"),
    };

    // Use CPU-only onnxruntime — GPU (DirectML) causes issues on Intel integrated GPUs
    let target_dir_str = format!(
        "../../apps/screenpipe-app-tauri/src-tauri/{}",
        dir_name
    );
    let target_dir = Path::new(&target_dir_str);

    // Skip download if already present (CI pre-downloads via workflow step)
    if !target_dir.join("lib").join("onnxruntime.lib").exists() {
        let url = format!(
            "https://github.com/microsoft/onnxruntime/releases/download/v1.19.2/onnxruntime-win-{}-1.19.2.zip",
            arch_suffix
        );
        let zip_name = format!("onnxruntime-win-{}-1.19.2.zip", arch_suffix);
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("failed to build client");
        let resp = client.get(&url).send().expect("request failed");
        let body = resp.bytes().expect("body invalid");
        fs::write(&zip_name, &body).expect("failed to write");
        let unzip_path = find_unzip().expect(
            "could not find unzip executable - please install it via GnuWin32 or add it to PATH",
        );

        let status = Command::new(unzip_path)
            .args(["-o", &zip_name])
            .status()
            .expect("failed to execute unzip");

        if !status.success() {
            panic!("failed to install onnx binary");
        }
        if target_dir.exists() {
            fs::remove_dir_all(target_dir).expect("failed to remove existing directory");
        }
        fs::rename(dir_name, target_dir).expect("failed to rename");
    }
    println!(
        "cargo:rustc-link-search=native=../../apps/screenpipe-app-tauri/src-tauri/{}/lib",
        dir_name
    );
}
