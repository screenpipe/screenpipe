# ScreenPipe Mac M1 构建指南

## 问题背景

在较新的 Apple Silicon (M2/M3/M4) 上构建的 screenpipe 可能在 M1 设备上运行时出现非法指令错误，原因是 whisper.cpp/ggml 使用了 M2+ 才有的 i8mm 指令集。

## 解决方案

本分支通过以下方式强制 M1 兼容：

### 1. Cargo 配置 (.cargo/config.toml)

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

### 2. 关键环境变量

构建前设置：

```bash
export MACOSX_DEPLOYMENT_TARGET=10.15
export CFLAGS="-mmacosx-version-min=10.15 -mcpu=apple-m1"
export CXXFLAGS="-mmacosx-version-min=10.15 -mcpu=apple-m1"
```

### 3. 完整构建命令

```bash
# 清理之前的构建
rm -rf target/

# 设置环境变量
export MACOSX_DEPLOYMENT_TARGET=10.15
export CFLAGS="-mmacosx-version-min=10.15 -mcpu=apple-m1"
export CXXFLAGS="-mmacosx-version-min=10.15 -mcpu=apple-m1"

# 构建
cargo build --release --target aarch64-apple-darwin
```

## CI/CD 多架构构建

GitHub Actions 已配置为：
- 使用 `macos-latest` runner 构建 x86_64
- 使用 `macos-26` 或 `macos-test` self-hosted runner 构建 aarch64
- 自动检测 Xcode 版本并启用 Apple Intelligence（如可用）

## 兼容性检查

启动时会自动检测芯片架构，确保二进制与当前系统兼容。

## 测试验证

```bash
# 验证构建目标
cargo build --release --target aarch64-apple-darwin

# 检查生成的二进制文件支持的 CPU 特性
objdump -d target/aarch64-apple-darwin/release/screenpipe | grep -i "i8mm\|matmul" || echo "✓ 无 i8mm 指令"

# 在 M1 上运行测试
./target/aarch64-apple-darwin/release/screenpipe --version
```

## 已知限制

- Metal 加速需要 macOS 10.15+
- Apple Intelligence 功能需要 macOS 26+ 和 M1+ 芯片
