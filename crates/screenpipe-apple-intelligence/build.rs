use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // Only build on macOS
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        println!("cargo:warning=screenpipe-apple-intelligence only builds on macOS, skipping Swift compilation");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let swift_src = PathBuf::from("swift/bridge.swift");
    let lib_path = out_dir.join("libfoundation_models_bridge.a");

    // Get the macOS SDK path
    let sdk_output = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
        .expect("failed to run xcrun --show-sdk-path");
    let sdk_path = String::from_utf8(sdk_output.stdout)
        .unwrap()
        .trim()
        .to_string();

    // Check if the SDK supports macOS 26+ (FoundationModels.framework)
    // by looking at the SDK version. SDKs < 26 don't have FoundationModels.
    let sdk_settings_path = format!("{}/SDKSettings.json", sdk_path);
    let has_macos26_sdk = if let Ok(contents) = std::fs::read_to_string(&sdk_settings_path) {
        // Look for "Version" : "26.x" or higher
        contents.contains("\"26.") || contents.contains("\"27.") || contents.contains("\"28.")
    } else {
        // Fallback: check if FoundationModels.framework exists in the SDK
        std::path::Path::new(&format!(
            "{}/System/Library/Frameworks/FoundationModels.framework",
            sdk_path
        ))
        .exists()
    };

    if !has_macos26_sdk {
        println!("cargo:warning=macOS SDK does not include FoundationModels.framework (need macOS 26+ SDK), building stub");
        // Create a minimal stub library so linking doesn't fail.
        // All functions return error codes indicating unavailability.
        let stub_src = out_dir.join("stub.c");
        std::fs::write(
            &stub_src,
            r#"// Stub: FoundationModels not available on this SDK
#include <stdlib.h>
#include <string.h>

static char* make_string(const char* s) {
    char* p = malloc(strlen(s) + 1);
    if (p) strcpy(p, s);
    return p;
}

int fm_check_availability(char** out_reason) {
    if (out_reason) *out_reason = make_string("FoundationModels SDK not available at build time");
    return 4; // unknown/unavailable
}

void fm_free_string(char* ptr) { if (ptr) free(ptr); }

int fm_generate_text(const char* inst, const char* prompt, char** out_text, char** out_error,
                     double* time_ms, unsigned long long* mem_before, unsigned long long* mem_after) {
    if (out_error) *out_error = make_string("Apple Intelligence not available (built without macOS 26 SDK)");
    if (out_text) *out_text = 0;
    if (time_ms) *time_ms = 0;
    if (mem_before) *mem_before = 0;
    if (mem_after) *mem_after = 0;
    return -1;
}

int fm_generate_json(const char* inst, const char* prompt, const char* schema,
                     char** out_text, char** out_error,
                     double* time_ms, unsigned long long* mem_before, unsigned long long* mem_after) {
    if (out_error) *out_error = make_string("Apple Intelligence not available (built without macOS 26 SDK)");
    if (out_text) *out_text = 0;
    if (time_ms) *time_ms = 0;
    if (mem_before) *mem_before = 0;
    if (mem_after) *mem_after = 0;
    return -1;
}

int fm_prewarm(void) { return -1; }

char* fm_supported_languages(void) { return make_string("[]"); }
"#,
        )
        .expect("failed to write stub");

        let status = Command::new("cc")
            .args(["-c", "-o"])
            .arg(out_dir.join("stub.o").to_str().unwrap())
            .arg(stub_src.to_str().unwrap())
            .status()
            .expect("failed to compile stub");
        assert!(status.success(), "stub compilation failed");

        let status = Command::new("ar")
            .args(["rcs"])
            .arg(&lib_path)
            .arg(out_dir.join("stub.o").to_str().unwrap())
            .status()
            .expect("failed to create stub archive");
        assert!(status.success(), "stub archive failed");

        println!("cargo:rustc-link-search=native={}", out_dir.display());
        println!("cargo:rustc-link-lib=static=foundation_models_bridge");
        println!("cargo:rerun-if-changed=swift/bridge.swift");
        return;
    }

    // Compile Swift to static library
    let status = Command::new("swiftc")
        .args([
            "-emit-library",
            "-static",
            "-module-name",
            "FoundationModelsBridge",
            "-sdk",
            &sdk_path,
            "-target",
            "arm64-apple-macos14.0",
            "-O",
            "-whole-module-optimization",
            "-o",
        ])
        .arg(&lib_path)
        .arg(&swift_src)
        .status()
        .expect("failed to run swiftc");

    if !status.success() {
        panic!("swiftc compilation failed");
    }

    println!("cargo:rerun-if-changed=swift/bridge.swift");
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=foundation_models_bridge");

    // Link required system frameworks and Swift runtime
    // Weak-link so the app can launch on macOS versions without FoundationModels.framework
    // (only available on macOS 26+). The framework is loaded at runtime if present.
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,FoundationModels");
    println!("cargo:rustc-link-lib=framework=Foundation");

    // Swift runtime libraries
    let _swift_lib_dir_output = Command::new("xcrun")
        .args(["--toolchain", "default", "--find", "swift-stdlib-tool"])
        .output()
        .ok();

    // Link Swift standard library path
    let toolchain_output = Command::new("xcrun")
        .args(["--toolchain", "default", "--show-sdk-platform-path"])
        .output()
        .expect("failed to find toolchain");
    let platform_path = String::from_utf8(toolchain_output.stdout)
        .unwrap()
        .trim()
        .to_string();

    // Standard Swift runtime lib directories
    let swift_lib_paths = [
        format!("{}/Developer/usr/lib/swift/macosx", platform_path),
        "/usr/lib/swift".to_string(),
        format!("{}/usr/lib/swift", sdk_path),
        format!("{}/usr/lib/swift/macosx", sdk_path),
    ];

    for path in &swift_lib_paths {
        if std::path::Path::new(path).exists() {
            println!("cargo:rustc-link-search=native={}", path);
        }
    }

    // Also add Xcode's Swift runtime
    if let Ok(xcode_dev_output) = Command::new("xcode-select").arg("-p").output() {
        let xcode_dev = String::from_utf8(xcode_dev_output.stdout)
            .unwrap()
            .trim()
            .to_string();
        let xcode_swift = format!(
            "{}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx",
            xcode_dev
        );
        if std::path::Path::new(&xcode_swift).exists() {
            println!("cargo:rustc-link-search=native={}", xcode_swift);
        }
        let xcode_swift_static = format!(
            "{}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift_static/macosx",
            xcode_dev
        );
        if std::path::Path::new(&xcode_swift_static).exists() {
            println!("cargo:rustc-link-search=native={}", xcode_swift_static);
        }
    }

    // Add rpaths so Swift runtime dylibs can be found at runtime
    // Swift concurrency, observation, etc. live in /usr/lib/swift
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../lib/swift/macosx");

    // Also add the Xcode toolchain rpath as fallback
    if let Ok(xcode_dev_output) = Command::new("xcode-select").arg("-p").output() {
        let xcode_dev = String::from_utf8(xcode_dev_output.stdout)
            .unwrap()
            .trim()
            .to_string();
        let toolchain_rpath = format!(
            "{}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx",
            xcode_dev
        );
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", toolchain_rpath);
    }
}
