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
    use std::{path::Path, process::Command};

    // Use CPU-only onnxruntime — GPU (DirectML) causes issues on Intel integrated GPUs.
    // Windows ARM64 (aarch64-pc-windows-msvc) uses onnxruntime-win-arm64-*.
    let arch_var = env::var("CARGO_CFG_TARGET_ARCH");
    let arch = arch_var.as_deref().unwrap_or("x86_64");
    let (pkg_name, zip_name) = if arch == "aarch64" {
        (
            "onnxruntime-win-arm64-1.22.0",
            "onnxruntime-win-arm64-1.22.0.zip",
        )
    } else {
        (
            "onnxruntime-win-x64-1.22.0",
            "onnxruntime-win-x64-1.22.0.zip",
        )
    };
    let target_dir = Path::new("../../apps/screenpipe-app-tauri/src-tauri").join(pkg_name);

    // Skip download if already present (CI pre-downloads via release-app.yml /
    // release-cli.yml workflow steps; local Windows devs hit the curl path).
    //
    // Why not reqwest: reqwest 0.13's `rustls` feature pulls aws-lc-sys, whose
    // C objects reference `__builtin_bswap{16,32,64}` — GCC intrinsics MSVC
    // doesn't understand. Linking *this* build script binary therefore fails
    // with LNK2001 unresolved external. The screenpipe-app crate works around
    // it with a bswap_shim.c, but that shim is only linked into the final
    // binary, not into per-crate build scripts. Curl is universally present
    // on every CI runner image and on Win10+ by default, so calling it from
    // Command keeps the build script free of any TLS dep.
    if !target_dir.join("lib").join("onnxruntime.lib").exists() {
        let url = format!(
            "https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/{}",
            zip_name
        );
        let status = Command::new("curl")
            .args(["-fsSL", "--retry", "3", "-o", zip_name, &url])
            .status()
            .expect("failed to execute curl");
        if !status.success() {
            panic!("failed to download onnx binary via curl");
        }
        let unzip_path = find_unzip().expect(
            "could not find unzip executable - please install it via GnuWin32 or add it to PATH",
        );

        let status = Command::new(unzip_path)
            .args(["-o", zip_name])
            .status()
            .expect("failed to execute unzip");

        if !status.success() {
            panic!("failed to install onnx binary");
        }
        if target_dir.exists() {
            fs::remove_dir_all(&target_dir).expect("failed to remove existing directory");
        }
        fs::rename(pkg_name, &target_dir).expect("failed to rename");
    }
    // Windows x86_64: emit link so we link against our extracted ONNX Runtime.
    // Windows aarch64: we use load-dynamic; ort loads our DLL at runtime via init_ort_from_dll(), no link here.
    if arch != "aarch64" {
        println!(
            "cargo:rustc-link-search=native=../../apps/screenpipe-app-tauri/src-tauri/{}/lib",
            pkg_name
        );
        println!("cargo:rustc-link-lib=dylib=onnxruntime");
    }
}
