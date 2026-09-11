use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct AppIcon {
    pub data: Vec<u8>,
    pub path: Option<String>,
}

#[cfg(target_os = "macos")]
pub(crate) fn encode_nsimage_as_small_png(icon: cocoa::base::id) -> Option<Vec<u8>> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSData, NSPoint, NSRect, NSSize};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        if icon == nil {
            return None;
        }

        let target_size = NSSize::new(32.0, 32.0);
        let target_rect = NSRect::new(NSPoint::new(0.0, 0.0), target_size);
        let zero_rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
        let resized: id = msg_send![class!(NSImage), alloc];
        let resized: id = msg_send![resized, initWithSize: target_size];
        if resized == nil {
            return None;
        }

        let _: () = msg_send![resized, lockFocus];
        // NSCompositingOperationSourceOver = 2.
        let _: () = msg_send![
            icon,
            drawInRect: target_rect
            fromRect: zero_rect
            operation: 2usize
            fraction: 1.0f64
        ];
        let _: () = msg_send![resized, unlockFocus];

        let tiff_data: id = msg_send![resized, TIFFRepresentation];
        if tiff_data == nil {
            let _: () = msg_send![resized, release];
            return None;
        }

        let image_rep: id = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff_data];
        if image_rep == nil {
            let _: () = msg_send![resized, release];
            return None;
        }

        // NSBitmapImageFileTypePNG = 4.
        let png_data: id = msg_send![image_rep, representationUsingType: 4usize properties:nil];
        if png_data == nil {
            let _: () = msg_send![resized, release];
            return None;
        }

        let length = NSData::length(png_data);
        let bytes = NSData::bytes(png_data);
        let data = std::slice::from_raw_parts(bytes as *const u8, length as usize).to_vec();
        let _: () = msg_send![resized, release];

        Some(data)
    }
}

#[cfg(target_os = "macos")]
pub async fn get_app_icon(
    app_name: &str,
    app_path: Option<String>,
) -> Result<Option<AppIcon>, String> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSAutoreleasePool, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let pool = NSAutoreleasePool::new(nil);

        let result = (|| {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];

            let path = if let Some(path) = app_path {
                path
            } else {
                let ns_app_name = NSString::alloc(nil).init_str(app_name);
                let path: id = msg_send![workspace, fullPathForApplication: ns_app_name];
                let _: () = msg_send![ns_app_name, release];

                if path == nil {
                    return Ok(None);
                }
                let path: id = msg_send![path, UTF8String];
                std::ffi::CStr::from_ptr(path as *const _)
                    .to_string_lossy()
                    .into_owned()
            };

            let ns_path = NSString::alloc(nil).init_str(&path);
            let icon: id = msg_send![workspace, iconForFile:ns_path];
            let _: () = msg_send![ns_path, release];

            if icon == nil {
                return Ok(None);
            }

            let Some(data) = encode_nsimage_as_small_png(icon) else {
                return Ok(None);
            };

            Ok(Some(AppIcon {
                data,
                path: Some(path),
            }))
        })();

        let _: () = msg_send![pool, drain];

        result
    }
}

#[cfg(target_os = "windows")]
use lazy_static::lazy_static;
#[cfg(target_os = "windows")]
use std::sync::Arc;
#[cfg(target_os = "windows")]
use tokio::sync::Semaphore;

#[cfg(target_os = "windows")]
lazy_static! {
    static ref SEMAPHORE: Arc<Semaphore> = Arc::new(Semaphore::new(5));
}

#[cfg(target_os = "windows")]
pub async fn get_app_icon(
    app_name: &str,
    app_path: Option<String>,
) -> Result<Option<AppIcon>, String> {
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};
    use std::io::Cursor;
    use windows_icons::get_icon_by_path;

    async fn find_exe_path(app_name: &str) -> Option<String> {
        if let Some(path) = get_exe_by_reg_key(app_name) {
            return Some(path);
        }
        if let Some(path) = get_exe_by_appx(app_name).await {
            return Some(path);
        }
        if let Some(path) = get_exe_from_potential_path(app_name).await {
            return Some(path);
        }
        None
    }

    let path = match app_path {
        Some(p) => p,
        None => find_exe_path(app_name)
            .await
            .ok_or_else(|| "app_path is None and could not find executable path".to_string())?,
    };

    let image_buffer = async { get_icon_by_path(&path) }
        .await
        .map_err(|e| e.to_string())?;

    let mut data = Vec::new();
    {
        let mut cursor = Cursor::new(&mut data);
        let encoder = PngEncoder::new(&mut cursor);
        encoder
            .write_image(
                &image_buffer,
                image_buffer.width(),
                image_buffer.height(),
                ExtendedColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(Some(AppIcon {
        data,
        path: Some(path),
    }))
}

#[cfg(target_os = "windows")]
fn get_exe_by_reg_key(app_name: &str) -> Option<String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let app_lower = app_name.to_lowercase();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // First try App Paths direct lookup (e.g. "wezterm-gui.exe" subkey)
    let app_paths = [
        "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    ];
    for path in &app_paths {
        for root in [&hklm, &hkcu] {
            // Try exact exe name as subkey (e.g. "wezterm-gui.exe")
            let exe_key = format!("{}.exe", app_name);
            if let Ok(app_key) = root.open_subkey(format!("{}\\{}", path, exe_key)) {
                if let Ok(exe_path) = app_key.get_value::<String, _>("") {
                    let cleaned = exe_path.trim_matches('"').to_string();
                    if !cleaned.is_empty() && std::path::Path::new(&cleaned).exists() {
                        return Some(cleaned);
                    }
                }
            }
        }
    }

    // Then search Uninstall + App Paths for DisplayName match
    let reg_paths = [
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    ];

    for path in &reg_paths {
        let keys = [hklm.open_subkey(path), hkcu.open_subkey(path)];
        for key in keys.iter().filter_map(|k| k.as_ref().ok()) {
            for subkey in key.enum_keys().filter_map(Result::ok) {
                let subkey_lower = subkey.to_lowercase();
                if let Ok(app_key) = key.open_subkey(&subkey) {
                    // Match on DisplayName or subkey name (App Paths uses exe name)
                    let display_match = app_key
                        .get_value::<String, _>("DisplayName")
                        .map(|d| names_match(&d, app_name))
                        .unwrap_or(false);
                    let subkey_match = names_match(&subkey_lower, &app_lower)
                        || names_match(&subkey_lower.trim_end_matches(".exe"), &app_lower);

                    if display_match || subkey_match {
                        if let Ok(path) = app_key.get_value::<String, _>("DisplayIcon") {
                            let cleaned_path = path
                                .split(',')
                                .next()
                                .unwrap_or(&path)
                                .to_string()
                                .trim_matches('"')
                                .to_string();
                            if std::path::Path::new(&cleaned_path).exists() {
                                return Some(cleaned_path);
                            }
                        }
                        // App Paths uses default value ""
                        if let Ok(path) = app_key.get_value::<String, _>("") {
                            let cleaned_path = path.trim_matches('"').to_string();
                            if !cleaned_path.is_empty()
                                && std::path::Path::new(&cleaned_path).exists()
                            {
                                return Some(cleaned_path);
                            }
                        }
                        if let Ok(path) = app_key.get_value::<String, _>("InstallLocation") {
                            let install_dir = std::path::Path::new(path.trim_matches('"'));
                            if install_dir.is_dir() {
                                // Look for any exe matching app_name in install dir
                                if let Ok(entries) = std::fs::read_dir(install_dir) {
                                    for entry in entries.flatten() {
                                        let fname =
                                            entry.file_name().to_string_lossy().to_lowercase();
                                        if fname.ends_with(".exe") && fname.contains(&app_lower) {
                                            return Some(
                                                entry.path().to_string_lossy().to_string(),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn powershell_exe() -> std::path::PathBuf {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    std::path::PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

/// Strip dots, dashes, underscores and spaces so "screenpi.pe" matches "screenpipe",
/// "wezterm-gui" matches "wezterm", etc.
#[cfg(target_os = "windows")]
fn normalize_app_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

/// Check whether two app names are "similar enough" to be considered the same app.
/// Uses both substring matching and normalized (punctuation-stripped) matching.
#[cfg(target_os = "windows")]
fn names_match(folder: &str, search: &str) -> bool {
    let fl = folder.to_lowercase();
    let sl = search.to_lowercase();
    if fl.contains(&sl) || sl.contains(&fl) {
        return true;
    }
    let fn_norm = normalize_app_name(folder);
    let sn_norm = normalize_app_name(search);
    fn_norm.contains(&sn_norm) || sn_norm.contains(&fn_norm)
}

#[cfg(target_os = "windows")]
async fn get_exe_from_potential_path(app_name: &str) -> Option<String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let app_name = app_name.strip_suffix(".exe").unwrap_or(&app_name);

    let app_lower = app_name.to_lowercase();

    // Try %LOCALAPPDATA% first — Electron apps (Slack, Discord, etc.) install here
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let local_dir = std::path::Path::new(&local_app_data);
        if let Ok(entries) = std::fs::read_dir(local_dir) {
            for entry in entries.flatten() {
                let folder_name = entry.file_name().to_string_lossy().to_lowercase();
                if names_match(&folder_name, &app_lower) {
                    let entry_path = entry.path();
                    // Electron pattern: %LOCALAPPDATA%\<app>\app-*\<app>.exe
                    if let Ok(sub_entries) = std::fs::read_dir(&entry_path) {
                        for sub in sub_entries.flatten() {
                            let sub_name = sub.file_name().to_string_lossy().to_lowercase();
                            // Check versioned "app-X.Y.Z" subdirs (Electron/Squirrel)
                            if sub_name.starts_with("app-") && sub.path().is_dir() {
                                if let Ok(app_entries) = std::fs::read_dir(sub.path()) {
                                    for app_entry in app_entries.flatten() {
                                        let fname =
                                            app_entry.file_name().to_string_lossy().to_lowercase();
                                        if fname.ends_with(".exe") && fname.contains(&app_lower) {
                                            return Some(
                                                app_entry.path().to_string_lossy().to_string(),
                                            );
                                        }
                                    }
                                }
                            }
                            // Direct exe in app folder
                            if sub_name.ends_with(".exe") && sub_name.contains(&app_lower) {
                                return Some(sub.path().to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
        // Also check %LOCALAPPDATA%\Programs (e.g. cursor, VS Code user installs)
        let programs_dir = local_dir.join("Programs");
        if let Ok(entries) = std::fs::read_dir(&programs_dir) {
            for entry in entries.flatten() {
                let folder_name = entry.file_name().to_string_lossy().to_lowercase();
                if names_match(&folder_name, &app_lower) {
                    if let Ok(sub_entries) = std::fs::read_dir(entry.path()) {
                        for sub in sub_entries.flatten() {
                            let fname = sub.file_name().to_string_lossy().to_lowercase();
                            if fname.ends_with(".exe")
                                && (fname.contains(&app_lower) || fname.contains("gui"))
                            {
                                return Some(sub.path().to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // Try direct path in Program Files (fast, no PowerShell)
    let program_dirs = [r"C:\Program Files", r"C:\Program Files (x86)"];
    for dir in &program_dirs {
        let base = std::path::Path::new(dir);
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                let folder_name = entry.file_name().to_string_lossy().to_lowercase();
                if names_match(&folder_name, &app_lower) {
                    // Found matching folder, look for exe inside
                    if let Ok(sub_entries) = std::fs::read_dir(entry.path()) {
                        for sub in sub_entries.flatten() {
                            let fname = sub.file_name().to_string_lossy().to_lowercase();
                            if fname.ends_with(".exe")
                                && (fname.contains(&app_lower) || fname.contains("gui"))
                            {
                                return Some(sub.path().to_string_lossy().to_string());
                            }
                        }
                    }
                    // Also check for direct exe match
                    let direct_exe = entry.path().join(format!("{}.exe", app_name));
                    if direct_exe.exists() {
                        return Some(direct_exe.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    let potential_paths = [
        (
            r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs",
            true,
        ),
        (r"C:\Windows\", false),
    ];
    for (path, recursive) in &potential_paths {
        let command = if *recursive {
            format!(
                r#"
                    Get-ChildItem -Path "{}" -Filter "*{}*.exe" -Recurse | ForEach-Object {{ $_.FullName }}
                    "#,
                path, app_name
            )
        } else {
            format!(
                r#"
                    Get-ChildItem -Path "{}" -Filter "*{}*.exe" | ForEach-Object {{ $_.FullName }}
                    "#,
                path, app_name
            )
        };

        let _permit = SEMAPHORE.acquire().await.unwrap();

        let output = tokio::process::Command::new(powershell_exe())
            .arg("-NoProfile")
            .arg("-WindowStyle")
            .arg("hidden")
            .arg("-Command")
            .arg(command)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await
            .ok()?;

        if output.status.success() {
            let stdout = std::str::from_utf8(&output.stdout).ok()?;
            if !stdout.is_empty() {
                return stdout.lines().next().map(str::to_string);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
async fn get_exe_by_appx(app_name: &str) -> Option<String> {
    use std::str;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let app_name = app_name.strip_suffix(".exe").unwrap_or(&app_name);
    let app_name_withoutspace = app_name.replace(" ", "");

    let _permit = SEMAPHORE.acquire().await.unwrap();

    let output = tokio::process::Command::new(powershell_exe())
        .arg("-NoProfile")
        .arg("-WindowStyle")
        .arg("hidden")
        .arg("-Command")
        .arg(format!(
            r#"Get-AppxPackage | Where-Object {{ $_.Name -like "*{}*" }}"#,
            app_name_withoutspace
        ))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = str::from_utf8(&output.stdout).ok()?;
    let package_name = stdout
        .lines()
        .find(|line| line.contains("PackageFullName"))
        .and_then(|line| line.split(':').nth(1))
        .map(str::trim)?;

    let exe_output = tokio::process::Command::new(powershell_exe())
        .arg("-NoProfile")
        .arg("-WindowStyle")
        .arg("hidden")
        .arg("-Command")
        .arg(format!(
            r#"
                        Get-ChildItem -Path "C:\Program Files\WindowsApps\{}\*" -Filter "*{}*.exe" -Recurse | ForEach-Object {{ $_.FullName }}
                    "#,
            package_name,
            app_name_withoutspace
        ))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .ok()?;

    if exe_output.status.success() {
        let exe_stdout = str::from_utf8(&exe_output.stdout).ok()?;
        if !exe_stdout.is_empty() {
            return exe_stdout.lines().next().map(str::to_string);
        }
    }
    // second attempt with space if the first attempt couldn't find exe
    let exe_output = tokio::process::Command::new(powershell_exe())
        .arg("-NoProfile")
        .arg("-WindowStyle")
        .arg("hidden")
        .arg("-Command")
        .arg(format!(
            r#"
                        Get-ChildItem -Path "C:\Program Files\WindowsApps\{}\*" -Filter "*{}*.exe" -Recurse | ForEach-Object {{ $_.FullName }}
                    "#,
            package_name,
            app_name
        ))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .ok()?;

    if exe_output.status.success() {
        let exe_stdout = str::from_utf8(&exe_output.stdout).ok()?;
        if !exe_stdout.is_empty() {
            return exe_stdout.lines().next().map(str::to_string);
        }
    }
    None
}

#[cfg(target_os = "linux")]
mod linux_icon_cache {
    use crate::AppIcon;
    use freedesktop_desktop_entry::DesktopEntry;
    use gtk::glib::{clone, MainContext};
    use gtk::prelude::{DeviceExt, IconThemeExt};
    use image::codecs::png::PngEncoder;
    use image::{
        ColorType, DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat, ImageReader,
    };
    use ini::configparser::ini::Ini;
    use lazy_static::lazy_static;
    use log::{error, info};
    use resvg::tiny_skia::PixmapMut;
    use resvg::{tiny_skia, usvg};
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::{env, fs};
    use xdg::BaseDirectories;

    pub struct IconCache {
        map: HashMap<String, String>,
    }

    lazy_static! {
        static ref ICON_CACHE: IconCache = IconCache::new();
    }

    impl IconCache {
        pub fn new() -> Self {
            let map = Self::load_icons();
            Self { map }
        }

        fn load_icons() -> HashMap<String, String> {
            let mut map = HashMap::new();

            let xdg_data_dirs =
                env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/share".to_string());
            let app_directories: Vec<PathBuf> = xdg_data_dirs
                .split(':')
                .map(|dir| Path::new(dir).join("applications"))
                .collect();

            let mut search_paths = vec![
                Path::new("/usr/share/applications").to_path_buf(),
                Path::new("/usr/local/share/applications").to_path_buf(),
            ];

            if let Ok(base_dirs) = BaseDirectories::new() {
                if let Some(config_directory) = base_dirs.find_config_file("") {
                    search_paths.push(config_directory);
                }
            }

            search_paths.extend(app_directories);

            let local = env::var("LANG").unwrap_or_else(|_| "".to_string());
            let fallback_locale = "en_US"; // Fallback locale
            let locales = if local.is_empty() {
                vec![fallback_locale]
            } else {
                vec![local.as_str(), fallback_locale]
            };

            for search_path in &search_paths {
                if let Ok(entries) = fs::read_dir(search_path) {
                    for entry in entries.flatten() {
                        if let Some(file_name) = entry.file_name().to_str() {
                            if file_name.ends_with(".desktop") {
                                if let Ok(desktop_entry) =
                                    DesktopEntry::from_path::<&str>(&entry.path(), None)
                                {
                                    if let Some(icon) = desktop_entry.icon() {
                                        let desktop_entry_name =
                                            file_name.trim_end_matches(".desktop");
                                        if let Some(app_name) = desktop_entry.name(&locales) {
                                            map.insert(app_name.to_lowercase(), icon.to_string());
                                        }
                                        map.insert(
                                            desktop_entry_name.to_string(),
                                            icon.to_string(),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }

            map
        }

        pub async fn get_app_icon(&self, app_name: &str) -> Result<Option<AppIcon>, String> {
            if let Some(icon) = self.map.get(app_name) {
                let icon_path = if Path::new(&icon).exists() {
                    icon.to_string()
                } else {
                    self.get_icon_path_from_name(&icon)
                        .await
                        .unwrap_or_default()
                };
                return self.load_icon_from_path(icon_path.as_str());
            }

            // If icon isn't in the map, try loading the icon path
            let icon_path = self.get_icon_path_from_name(app_name).await?;
            return self.load_icon_from_path(&icon_path);

            Err(format!("Icon for App '{}' not found", app_name))
        }

        async fn get_icon_path_from_name(&self, icon_name: &str) -> Result<String, String> {
            let main_context = MainContext::default();
            let (sender, receiver) = futures_channel::oneshot::channel();
            {
                let icon_name = icon_name.to_string();

                main_context.invoke(clone!(@strong icon_name => move || {
                    let result = gtk::IconTheme::default()
                        .and_then(|icon_theme| {
                            icon_theme
                                .lookup_icon(&icon_name, 64, gtk::IconLookupFlags::empty())
                                .and_then(|info| info.filename())
                                .map(|p| p.to_string_lossy().into_owned())
                        });

                    if result.is_some() {
                        info!("Icon path found for '{}'", icon_name);
                    } else {
                        error!("No icon found for '{}'", icon_name);
                    }

                    let _ = sender.send(result);
                }));
            }

            match receiver.await {
                Ok(Some(path)) => Ok(path),
                Ok(None) => {
                    error!("Could not find icon path for '{}'", icon_name);
                    Err(format!("Could not find icon path for '{}'", icon_name))
                }
                Err(e) => {
                    error!("Failed to receive icon path: {}", e);
                    Err("Failed to receive icon path from main context".to_string())
                }
            }
        }

        fn load_icon_from_path(&self, path: &str) -> Result<Option<AppIcon>, String> {
            let path = Path::new(path);
            if path.extension().map(|e| e == "svg").unwrap_or(false) {
                return self.convert_svg_to_jpeg(path);
            }
            // Load PNG/JPEG or other formats directly
            self.load_image(path)
        }

        fn load_image(&self, path: &Path) -> Result<Option<AppIcon>, String> {
            let data = fs::read(path).map_err(|e| format!("Failed to read icon file: {}", e))?;
            Ok(Some(AppIcon {
                data,
                path: Some(path.to_string_lossy().into_owned()),
            }))
        }

        fn convert_svg_to_jpeg(&self, svg_path: &Path) -> Result<Option<AppIcon>, String> {
            // Load SVG file
            let svg_data = std::fs::read(svg_path).map_err(|e| e.to_string())?;

            // Parse the SVG using usvg
            let options = usvg::Options::default();
            let svg_tree = resvg::usvg::Tree::from_data(&svg_data, &options)
                .map_err(|e| format!("Failed to parse SVG: {}", e))?;

            let svg_size = svg_tree.size();
            let width = svg_size.width() as u32;
            let height = svg_size.height() as u32;

            // Create a rendering context with the intrinsic dimensions
            let mut pixmap =
                tiny_skia::Pixmap::new(width, height).ok_or("Failed to create pixmap")?;

            // Apply the rendering and transformation
            resvg::render(
                &svg_tree,
                tiny_skia::Transform::default(),
                &mut pixmap.as_mut(),
            );

            // Convert image to JPEG format
            let mut cursor = Cursor::new(Vec::new());
            let encoder = PngEncoder::new(&mut cursor);
            encoder
                .write_image(
                    &pixmap.data(),
                    pixmap.width(),
                    pixmap.height(),
                    ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;

            // Return the icon as a vector of bytes
            Ok(Some(AppIcon {
                data: cursor.into_inner(),
                path: svg_path.to_str().map(|s| s.to_string()),
            }))
        }
    }

    pub async fn get_app_icon(
        app_name: &str,
        _app_path: Option<String>,
    ) -> Result<Option<AppIcon>, String> {
        ICON_CACHE.get_app_icon(app_name).await
    }
}

#[cfg(target_os = "linux")]
pub async fn get_app_icon(
    app_name: &str,
    app_path: Option<String>,
) -> Result<Option<AppIcon>, String> {
    linux_icon_cache::get_app_icon(app_name.to_lowercase().as_str(), app_path).await
}

/// Best-effort enumeration of installed applications by display name.
///
/// Powers the privacy window-filter UI so users can add an ignore/include rule
/// for an app *before* it has ever been captured — paired with `get_app_icon`,
/// which already resolves an icon for any installed app by name. Read-only
/// directory scans; never errors (returns an empty list on any failure).
/// Names are deduped and sorted.
#[cfg(target_os = "macos")]
pub fn list_installed_apps() -> Vec<String> {
    use std::collections::BTreeSet;

    let mut names: BTreeSet<String> = BTreeSet::new();
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [
        "/Applications".to_string(),
        "/Applications/Utilities".to_string(),
        "/System/Applications".to_string(),
        "/System/Applications/Utilities".to_string(),
        format!("{home}/Applications"),
    ];

    for dir in dirs.iter() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("app") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    names.insert(stem.to_string());
                }
            }
        }
    }

    names.into_iter().collect()
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::encode_nsimage_as_small_png;
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSAutoreleasePool, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    fn first_available_system_icon() -> Option<id> {
        unsafe {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            for app_name in ["Safari", "TextEdit", "Finder"] {
                let ns_app_name = NSString::alloc(nil).init_str(app_name);
                let path: id = msg_send![workspace, fullPathForApplication: ns_app_name];
                let _: () = msg_send![ns_app_name, release];
                if path == nil {
                    continue;
                }

                let icon: id = msg_send![workspace, iconForFile: path];
                if icon != nil {
                    return Some(icon);
                }
            }
            None
        }
    }

    #[test]
    fn macos_icon_encoder_returns_small_png() {
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let icon = first_available_system_icon().expect("expected a system app icon on macOS");
            let data = encode_nsimage_as_small_png(icon).expect("expected encoded app icon");
            let _: () = msg_send![pool, drain];

            assert!(
                data.starts_with(b"\x89PNG\r\n\x1a\n"),
                "app icon should be encoded as PNG, got first bytes: {:02x?}",
                &data[..data.len().min(8)]
            );
            assert!(
                data.len() < 128 * 1024,
                "downsampled app icon should stay small, got {} bytes",
                data.len()
            );
        }
    }
}

#[cfg(target_os = "windows")]
pub fn list_installed_apps() -> Vec<String> {
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    fn collect_lnk_stems(dir: &Path, names: &mut BTreeSet<String>, depth: usize) {
        if depth > 4 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_lnk_stems(&path, names, depth + 1);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("lnk"))
                .unwrap_or(false)
            {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    let low = stem.to_lowercase();
                    // Start Menu folders are noisy with non-app shortcuts.
                    if low.contains("uninstall") || low.contains("readme") {
                        continue;
                    }
                    names.insert(stem.to_string());
                }
            }
        }
    }

    let mut names: BTreeSet<String> = BTreeSet::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(pd) = std::env::var("ProgramData") {
        roots.push(PathBuf::from(pd).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Ok(ad) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(ad).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    for root in roots {
        collect_lnk_stems(&root, &mut names, 0);
    }

    names.into_iter().collect()
}

#[cfg(target_os = "linux")]
pub fn list_installed_apps() -> Vec<String> {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share/applications"));
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_DIRS") {
        for d in xdg.split(':') {
            if !d.is_empty() {
                dirs.push(PathBuf::from(d).join("applications"));
            }
        }
    }

    let mut names: BTreeSet<String> = BTreeSet::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            // First `Name=` in the entry, skipping hidden launchers.
            let mut name: Option<String> = None;
            let mut hidden = false;
            for line in content.lines() {
                let line = line.trim();
                if let Some(v) = line.strip_prefix("Name=") {
                    if name.is_none() {
                        name = Some(v.trim().to_string());
                    }
                } else if line.eq_ignore_ascii_case("NoDisplay=true")
                    || line.eq_ignore_ascii_case("Hidden=true")
                {
                    hidden = true;
                }
            }
            if hidden {
                continue;
            }
            if let Some(n) = name {
                if !n.is_empty() {
                    names.insert(n);
                }
            }
        }
    }

    names.into_iter().collect()
}
