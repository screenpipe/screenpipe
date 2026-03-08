# contributing to screen pipe

first off, thank you for considering contributing to screen pipe!

btw, we prefer that you don't contribute if you are not using or will use the product and is just there for bounties, thank you.

## getting started

before you begin:
- try to run the [pre-built app](https://docs.screenpi.pe) to get familiar with the project
- familiarize yourself with the project structure and architecture.

## installation and build guide

### macos

1. **install dependencies**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   brew install pkg-config ffmpeg jq cmake wget git-lfs
   ```
   Install Xcode via App Store (or elsewhere) and initialize. Xcode command line tools only installation is insufficent. 
   ```
   sudo xcodebuild -license
   xcodebuild -runFirstLaunch
   ```

2. **install bun cli**:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

3. **clone the repository**:
   ```bash
   git clone https://github.com/screenpipe/screenpipe
   cd screenpipe
   ```

4. **build the project**:
   ```bash
   cargo build --release --features metal,apple-intelligence
   ```

5. **run screenpipe**:
   ```bash
   ./target/release/screenpipe
   ```

6. **build the desktop app**:
   ```bash
   cd apps/screenpipe-app-tauri
   bun install
   bun tauri build --features metal,apple-intelligence
   ```

### windows

1. **install winget (Prerequisite)**:
   - Before proceeding with the other installations, make sure you have `winget` installed. You can download and install it by following this guide: [Install winget](https://winget.pro/winget-install-powershell/).

2. **install required tools**:
   ```powershell
   winget install -e --id Microsoft.VisualStudio.2022.BuildTools
   winget install -e --id Rustlang.Rustup
   winget install -e --id LLVM.LLVM
   winget install -e --id Kitware.CMake
   winget install -e --id GnuWin32.UnZip
   winget install -e --id Git.Git
   winget install -e --id JernejSimoncic.Wget
   winget install -e --id 7zip.7zip
   irm https://bun.sh/install.ps1 | iex
   ```

3. **set environment variables**:
   ```powershell
   [System.Environment]::SetEnvironmentVariable('LIBCLANG_PATH', 'C:\Program Files\LLVM\bin', 'User')
   [System.Environment]::SetEnvironmentVariable('PATH', "$([System.Environment]::GetEnvironmentVariable('PATH', 'User'));C:\Program Files (x86)\GnuWin32\bin", 'User')
   ```

4. **clone the project**:
   ```powershell
      git clone https://github.com/screenpipe/screenpipe.git
      cd screenpipe
   ```
5. **make sure vcredist is present on system**:
   - make sure your in root of the project i.e screenpipe

   ```powershell
   cd screenpipe
   $path = "C:\Windows\System32\vcruntime140.dll"
   
   if (-Not (Test-Path $path)) {
       Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -Command "& {
           Set-ExecutionPolicy Bypass -Scope Process -Force
           [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
           $url = ''https://vcredist.com/install.ps1''
           $scriptPath = ''$env:TEMP\install_vcredist.ps1''
           Invoke-WebRequest -Uri $url -OutFile $scriptPath
           & $scriptPath
       }"' -Wait
   }
   
   # Verify installation
   if (-Not (Test-Path $path)) {
       Write-Host "Installation failed. Exiting."
       exit 1
   }
   
   # Copy vcruntime140.dll to the specified directory
   $vcredist_dir = (pwd).Path + "\apps\screenpipe-app-tauri\src-tauri\vcredist"
   New-Item -ItemType Directory -Force -Path $vcredist_dir | Out-Null
   Copy-Item $path -Destination $vcredist_dir -Force
   
   Write-Host "vcruntime140.dll copied successfully!"
   ```

6. **build**:
   ```powershell
   cd screenpipe
   cargo build --release
   cd apps/screenpipe-app-tauri
   bun install
   bun tauri build
   ```

### linux

1. **install dependencies**:
   ```bash
   sudo apt-get install -y g++ ffmpeg tesseract-ocr cmake libavformat-dev libavfilter-dev libavdevice-dev libssl-dev libtesseract-dev libxdo-dev libsdl2-dev libclang-dev libxtst-dev libpipewire-0.3-dev
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source ~/.bashrc
   ```

2. **install bun cli**:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

3. **install vulkan dependencies (optional, for AMD GPU acceleration)**:
   ```bash
   sudo apt-get install -y libvulkan-dev glslc
   ```

4. **clone and build**:
   ```bash
   git clone https://github.com/screenpipe/screenpipe
   cd screenpipe
   cargo build --release
   ```

5. **run the application**:
   ```bash
   ./target/release/screenpipe
   ```

6. **build the desktop app**:
   ```bash
   sudo apt-get install -y libayatana-appindicator3-1 libayatana-appindicator3-dev librsvg2-dev libwebkit2gtk-4.1-dev
   cd apps/screenpipe-app-tauri
   bun install
   bun tauri build
   ```

### docker

[check out the docker setup here](https://github.com/sabrehagen/desktop-environment/blob/730a3134362927f8965589f6322b4554e0a5e388/docker/Dockerfile#L403)

## how can i contribute?

### reporting bugs

this section guides you through submitting a bug report for screen pipe. following these guidelines helps maintainers and the community understand your report, reproduce the behavior, and find related reports.

- use a clear and descriptive title for the issue to identify the problem.
- describe the exact steps which reproduce the problem in as many details as possible.
- provide specific examples to demonstrate the steps.

### suggesting enhancements

this section guides you through submitting an enhancement suggestion for screen pipe, including completely new features and minor improvements to existing functionality.

- use a clear and descriptive title for the issue to identify the suggestion.
- provide a step-by-step description of the suggested enhancement in as many details as possible.
- explain why this enhancement would be useful to most screen pipe users.

### pull requests

- fill in the required template
- do not include issue numbers in the pr title
- include screenshots and animated gifs in your pull request whenever possible.
- follow the rust styleguides.
- end all files with a newline.

## styleguides

### git commit messages

- use the present tense ("add feature" not "added feature")
- use the imperative mood ("move cursor to..." not "moves cursor to...")
- limit the first line to 72 characters or less
- reference issues and pull requests liberally after the first line
- we use git commit history to generate changelog with AI, so make sure to write relevant commit messages

### rust styleguide

all rust code must adhere to [rust style guide](https://github.com/rust-lang/rust/tree/4f2f477fded0a47b21ed3f6aeddeafa5db8bf518/src/doc/style-guide/src).

we follow [this](https://doc.rust-lang.org/cargo/guide/project-layout.html) folder structure.

## additional notes

### principles 

- **user fanatic: focus on building what people want and bring maximum value.**
- concurrency: channels > mutexes/locks
- simplicity: avoid premature optimization. write code that is easy for humans to read, fast for machines to execute. less is more. optimise for less code, less files, less dependencies, less complexity.
- production: we're building real products
- focus: avoid feature creep. focus on the core functionality and build upon it. focus on the user and their needs.
- use numbers: if you can't measure it, you can't improve it.
- positive-sum

### issue and pull request labels

this section lists the labels we use to help us track and manage issues and pull requests.

* `bug` - issues that are bugs.
* `enhancement` - issues that are feature requests.
* `documentation` - issues or pull requests related to documentation.
* `good first issue` - good for newcomers.

## running tests

before submitting a pull request, run all the tests to ensure nothing has broken:

```bash
cargo test
```

## other hacks

### running dev + prod in the same time

one command i keep using to avoid having to kill my main "production" process is:

```bash
./target/release/screenpipe --port 3035 --data-dir /tmp/sp
```

it will avoid conflicts with the port and avoid conflicts with the data dir

especially useful if you've done new database migrations and want to avoid breaking your previous months of data :)

on macos the /tmp dir keeps being cleaned up by the system fyi

### debugging github action

ssh into the runner:

```yaml
- name: Setup tmate session # HACK
  if: matrix.platform == 'windows-latest'
  uses: mxschmitt/action-tmate@v3
```

run locally: https://github.com/nektos/act

### debugging memory errors

using tokio-console:

```bash
# terminal 1
RUST_LOG="tokio=debug,runtime=debug" RUSTFLAGS="--cfg tokio_unstable" cargo run --bin screenpipe --features debug-console
# terminal 2
cargo install tokio-console
tokio-console
```

```bash
RUSTFLAGS="-Z sanitizer=address" cargo run --bin screenpipe
# or
RUSTFLAGS="-Z sanitizer=leak" cargo run --bin screenpipe
```

for performance monitoring, you can use the following command:

```bash
cargo install cargo-instruments
# tracking leaks over 60 minutes time limit
cargo instruments -t Leaks --bin screenpipe --features metal --time-limit 600000 --open
```

then open the file in `target/release/instruments` using xcode -> open developer tool -> instruments.

### benchmarks

```
cargo bench
```

[check benchmark visuals](https://screenpipe.github.io/screenpipe/dev/bench/)

### creating new migrations

```bash
cargo install sqlx-cli
sqlx migrate add <migration_name>
```

### fixing database migration issues

if you encounter errors with missing migrations (e.g., `migration XXXXXXXXXX was previously applied but is missing`), you can fix it by removing the problematic migration from the SQLite database:

```bash
# remove specific migration
sqlite3 ~/.screenpipe/db.sqlite "DELETE FROM _sqlx_migrations WHERE version = XXXXXXXXXX;"

# verify migrations
sqlite3 ~/.screenpipe/db.sqlite "SELECT * FROM _sqlx_migrations;"

# if issues persist, you can take the nuclear approach:
# 1. backup your database
cp ~/.screenpipe/db.sqlite ~/.screenpipe/db.sqlite.backup

# 2. reset migrations table
sqlite3 ~/.screenpipe/db.sqlite "DROP TABLE _sqlx_migrations;"
```

### set up azure ubuntu vm with display & audio

```bash
# Set variables
RG_NAME="my-avd-rgg"
LOCATION="westus2" 
VM_NAME="ubuntu-avd"
IMAGE="Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest"
VM_SIZE="Standard_D2s_v3"  

# Create resource group
az group create --name $RG_NAME --location $LOCATION

# Create VM
az vm create \
  --resource-group $RG_NAME \
  --name $VM_NAME \
  --image $IMAGE \
  --admin-username azureuser \
  --generate-ssh-keys \
  --size $VM_SIZE

# Enable RDP
az vm open-port --port 3389 --resource-group $RG_NAME --name $VM_NAME

# Install xrdp, audio, and desktop environment
az vm run-command invoke \
  --resource-group $RG_NAME \
  --name $VM_NAME \
  --command-id RunShellScript \
  --scripts "
    sudo apt update && sudo apt install -y xrdp ubuntu-desktop pulseaudio
    sudo systemctl enable xrdp
    sudo adduser xrdp ssl-cert
    echo 'startxfce4' | sudo tee /etc/xrdp/startwm.sh
    sudo systemctl restart xrdp
    sudo ufw allow 3389/tcp
  "

# Enable audio redirection
az vm run-command invoke \
  --resource-group $RG_NAME \
  --name $VM_NAME \
  --command-id RunShellScript \
  --scripts "
    echo 'load-module module-native-protocol-tcp auth-anonymous=1' | sudo tee -a /etc/pulse/default.pa
    sudo systemctl restart pulseaudio
  "

# Get IP address
IP=$(az vm list-ip-addresses --resource-group $RG_NAME --name $VM_NAME --output table | grep -oE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" | head -1)

# Now you can open Microsoft Remote Desktop and use the IP in new PC to connect to it

# RDP into the VM
ssh azureuser@$IP

# Forwarding port to local 
ssh -L 13389:localhost:3389 azureuser@$IP

# Changing password
az vm user update \
  --resource-group $RG_NAME \
  --name $VM_NAME \
  --username azureuser \
  --password <new-password>
```

now you can either dev screenpipe on linux or run screenpipe in the cloud that record your local macos. make sure to configure microsoft remote desktop to forward audio

## generating openapi.yaml

run screenpipe first and then go to http://localhost:3030/openapi.yaml

```bash
open http://localhost:3030/openapi.yaml
```

we use this for our docs through mintlify, usually the output is broken and i use cursor agent to fix it using ths prompt:

```
please run this command:
npx @mintlify/scraping@latest openapi-file docs/mintlify/openapi.yaml -o /tmp
and fix the openapi.yaml file and rerun the command until it works
```

i also run this prompt in agent mode ...

```
how can i improve this openapi?
mainly want to showcase most useful endpoint in priority and stuff like getting context ...
get rid of semantic search bcs not prod rdy also
 @index.ts 
```

make sure to run 

`npx @mintlify/scraping@latest openapi-file docs/mintlify/openapi.yaml -o /tmp`

to validate the openapi.yaml file is valid btw before pushing 

## join the community

say 👋 in our [public discord channel](https://discord.gg/screenpipe). we discuss how to bring this lib to production, help each other with contributions, personal projects or just hang out ☕.

thank you for contributing to screen pipe! 🎉

## testing

testing is one of the toughtest challenge, we love any help improving the testing pipeline before going into production

see [TESTING.md](TESTING.md) for more details on the testing process.
