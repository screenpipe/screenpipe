#[cfg(target_os = "windows")]
fn link_onnx() {
    let arch_var = std::env::var("CARGO_CFG_TARGET_ARCH");
    let arch = arch_var.as_deref().unwrap_or("x86_64");
    // Windows aarch64 uses load-dynamic: ort loads our DLL at runtime, no compile-time link.
    if arch == "aarch64" {
        return;
    }
    let pkg = "onnxruntime-win-x64-1.19.2";
    println!(
        "cargo:rustc-link-search=native=../../apps/screenpipe-app-tauri/src-tauri/{}/lib",
        pkg
    );
    println!("cargo:rustc-link-lib=dylib=onnxruntime");
}

#[cfg(target_os = "macos")]
fn has_foundation_models_sdk() -> bool {
    let sdk_path = std::process::Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    let sdk_path = sdk_path.trim();

    // Check SDKSettings.json for version 26+
    let settings = format!("{}/SDKSettings.json", sdk_path);
    if let Ok(contents) = std::fs::read_to_string(&settings) {
        if contents.contains("\"26.") || contents.contains("\"27.") || contents.contains("\"28.") {
            return true;
        }
    }
    // Fallback: check if framework exists in SDK
    std::path::Path::new(&format!(
        "{}/System/Library/Frameworks/FoundationModels.framework",
        sdk_path
    ))
    .exists()
}

fn main() {
    #[cfg(target_os = "windows")]
    {
        link_onnx();
    }

    #[cfg(target_os = "macos")]
    {
        // Only weak-link FoundationModels if the SDK actually has it.
        // On macOS < 26 SDKs the framework doesn't exist and the linker fails
        // even with -weak_framework (can't weak-link what doesn't exist).
        if has_foundation_models_sdk() {
            println!("cargo:rustc-link-arg=-Wl,-weak_framework,FoundationModels");
        }
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
