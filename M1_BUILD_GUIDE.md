# ScreenPipe M1 Build Guide

This guide explains how to build ScreenPipe on Apple Silicon Macs (M1/M2/M3/M4) with proper compatibility settings.

## Problem Statement

When building ScreenPipe on newer Apple Silicon hosts (M2/M3/M4), native C/C++ dependencies like `whisper.cpp` and `ggml` may be compiled with host-default capabilities. This can introduce instructions (like ARM i8mm) that are unavailable on baseline M1 devices, causing crashes at runtime.

## Solution

The project now includes automatic M1-safe build configurations via `.cargo/config.toml`:

```toml
[target.aarch64-apple-darwin]
rustflags = [
    "-C", "target-cpu=apple-m1",
    "-C", "link-arg=-framework",
    "-C", "link-arg=Accelerate",
    "-l", "c++",
]

[env]
CFLAGS_aarch64_apple_darwin = "-mcpu=apple-m1"
CXXFLAGS_aarch64_apple_darwin = "-mcpu=apple-m1"
```

These settings ensure both Rust and native C/C++ compilation use M1 as the baseline target.

## Building from Source

### Prerequisites

- macOS 11.0+ (Big Sur or later)
- Xcode Command Line Tools
- Rust toolchain (via rustup)
- Homebrew

### Quick Build Steps

```bash
# 1. Clone the repository
git clone https://github.com/mediar-ai/screenpipe.git
cd screenpipe

# 2. Install dependencies
brew install ffmpeg pkg-config cmake

# 3. Build the project
cargo build --release

# Or for the Tauri app:
cd apps/screenpipe-app-tauri
bun install
bunx tauri build
```

### Verification

After building, verify the binary doesn't contain incompatible instructions:

```bash
# Check architecture
file target/release/screenpipe

# Expected output: Mach-O 64-bit executable arm64

# Verify no i8mm instructions (should return nothing)
otool -tv target/release/screenpipe | grep -i smmla || echo "✓ No i8mm instructions found"
```

## CI/CD Multi-Architecture Builds

The project includes GitHub Actions workflows for automated multi-architecture builds:

- **macOS ARM64 (M1-compatible)**: Built with `-mcpu=apple-m1` flags
- **macOS x86_64**: Intel Mac support
- **Windows x64**: Windows 10/11 support

See `.github/workflows/release-app.yml` for details.

## Runtime Compatibility Checking

Starting from v2.0.x, ScreenPipe includes a runtime compatibility checker that:

1. Detects your CPU model at startup
2. Warns if potential instruction set mismatches are detected
3. Provides recommendations for rebuilding if needed

To disable the warning:
```bash
SCREENPIPE_SKIP_M1_CHECK=1 screenpipe
```

## Troubleshooting

### Issue: Illegal instruction crash on M1

**Cause**: Binary was built on M2/M3/M4 without M1 compatibility flags

**Solution**: Rebuild with the provided `.cargo/config.toml` settings

### Issue: Build fails with "unknown target CPU"

**Cause**: Outdated Xcode or Rust toolchain

**Solution**:
```bash
# Update Xcode Command Line Tools
sudo softwareupdate -i "Command Line Tools"

# Update Rust
rustup update
```

### Issue: Metal performance warnings

**Cause**: M1 has fewer GPU cores than newer chips

**Solution**: This is expected. The app will automatically adjust quality settings for M1.

## Contributing

When submitting PRs that affect native dependencies:

1. Test builds on both M1 and M2/M3/M4 if possible
2. Ensure `.cargo/config.toml` changes don't break other platforms
3. Run the compatibility checker: `cargo test m1_compat`

## References

- [Apple Silicon Architecture Guide](https://developer.apple.com/documentation/apple-silicon)
- [Rust Target Triples](https://doc.rust-lang.org/nightly/rustc/platform-support.html)
- [whisper.cpp Build Docs](https://github.com/ggerganov/whisper.cpp/blob/master/README.md)
