// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

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
pub async fn get_app_icon(
    app_name: &str,
    app_path: Option<String>,
) -> Result<Option<AppIcon>, String> {
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};
    use std::io::Cursor;
    use windows_icons::get_icon_by_path;

    /// The searches read the registry and walk folders, so they run on a blocking
    /// thread rather than the async runtime that serves the app's other requests.
    async fn find_exe_path(app_name: &str) -> Option<String> {
        let app_name = app_name.to_string();
        tokio::task::spawn_blocking(move || {
            get_exe_by_reg_key(&app_name)
                .or_else(|| get_exe_by_appx(&app_name))
                .or_else(|| get_exe_from_potential_path(&app_name))
        })
        .await
        .ok()
        .flatten()
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

/// Returns the first `.exe` under `dir` whose file name contains `name_lower`
/// (case-insensitive), descending at most `max_depth` folder levels. A folder's
/// own files win over its subfolders', as with `Get-ChildItem -Recurse`. Junctions
/// and symlinked folders are not followed.
#[cfg(any(target_os = "windows", test))]
fn find_exe(dir: &std::path::Path, name_lower: &str, max_depth: usize) -> Option<String> {
    let mut subfolders = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if max_depth > 0 {
                subfolders.push(entry.path());
            }
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_lowercase();
        if file_name.ends_with(".exe") && file_name.contains(name_lower) {
            return Some(entry.path().to_string_lossy().into_owned());
        }
    }
    subfolders
        .iter()
        .find_map(|folder| find_exe(folder, name_lower, max_depth - 1))
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
fn get_exe_from_potential_path(app_name: &str) -> Option<String> {
    let app_name = app_name.strip_suffix(".exe").unwrap_or(app_name);

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
                }
            }
        }
    }

    // Start Menu (a few levels deep), then system tools such as notepad.exe.
    find_exe(
        std::path::Path::new(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs"),
        &app_lower,
        4,
    )
    .or_else(|| find_exe(std::path::Path::new(r"C:\Windows"), &app_lower, 0))
}

/// Installed Store (Appx/MSIX) apps as (package name, install folder).
#[cfg(any(target_os = "windows", test))]
type AppxPackages = Vec<(String, std::path::PathBuf)>;

/// How long the Store package list is reused, so new installs still show up.
#[cfg(target_os = "windows")]
const APPX_PACKAGES_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// Deep enough for packaged desktop apps under `VFS\ProgramFilesX64\<vendor>\...`.
#[cfg(any(target_os = "windows", test))]
const APPX_EXE_DEPTH: usize = 8;

/// Finds the app among installed Store packages. The name is only compared with
/// the package list here; it is never passed to another program.
#[cfg(target_os = "windows")]
fn get_exe_by_appx(app_name: &str) -> Option<String> {
    static PACKAGES: std::sync::Mutex<Option<(std::time::Instant, std::sync::Arc<AppxPackages>)>> =
        std::sync::Mutex::new(None);
    let packages = cached_appx_packages(&PACKAGES, APPX_PACKAGES_TTL, list_appx_packages);
    find_appx_exe(&packages, app_name)
}

/// Returns the list in `slot`, listing again once it is older than `ttl`. The
/// lock is held while listing, so callers at the same moment share one listing.
/// A failed listing isn't cached: callers keep the last list that worked, and
/// the next call tries again.
#[cfg(any(target_os = "windows", test))]
fn cached_appx_packages<E: std::fmt::Display>(
    slot: &std::sync::Mutex<Option<(std::time::Instant, std::sync::Arc<AppxPackages>)>>,
    ttl: std::time::Duration,
    list: impl FnOnce() -> Result<AppxPackages, E>,
) -> std::sync::Arc<AppxPackages> {
    let mut slot = slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((listed, packages)) = slot.as_ref() {
        if listed.elapsed() < ttl {
            return packages.clone();
        }
    }
    match list() {
        Ok(packages) => {
            let packages = std::sync::Arc::new(packages);
            *slot = Some((std::time::Instant::now(), packages.clone()));
            packages
        }
        Err(error) => {
            tracing::warn!("could not list Store packages: {error}");
            slot.as_ref()
                .map(|(_, packages)| packages.clone())
                .unwrap_or_default()
        }
    }
}

/// Lists the current user's Store apps (main packages; frameworks and resource
/// packs hold no apps) through the Windows package API, without starting a
/// process. `InstalledPath` needs Windows 10 1903 or later.
#[cfg(target_os = "windows")]
fn list_appx_packages() -> windows::core::Result<AppxPackages> {
    use windows::core::HSTRING;
    use windows::Management::Deployment::{PackageManager, PackageTypes};

    // An empty security ID means the current user, which needs no admin rights.
    let packages = PackageManager::new()?
        .FindPackagesByUserSecurityIdWithPackageTypes(&HSTRING::new(), PackageTypes::Main)?;
    Ok(packages
        .into_iter()
        .filter_map(|package| {
            let name = package.Id().ok()?.Name().ok()?.to_string();
            let folder = package.InstalledPath().ok()?.to_string();
            Some((name, std::path::PathBuf::from(folder)))
        })
        .collect())
}

/// Picks the first package whose name contains the app name (spaces removed, any
/// case), then the first `.exe` in its folder named like the app, trying the name
/// without and then with spaces.
#[cfg(any(target_os = "windows", test))]
fn find_appx_exe(packages: &AppxPackages, app_name: &str) -> Option<String> {
    let lower = app_name.to_lowercase();
    let name = lower.strip_suffix(".exe").unwrap_or(&lower);
    let compact = name.replace(' ', "");
    if compact.is_empty() {
        // An empty search term would match every package.
        return None;
    }
    let (_, folder) = packages
        .iter()
        .find(|(package, _)| package.to_lowercase().contains(&compact))?;
    let found = find_exe(folder, &compact, APPX_EXE_DEPTH);
    if found.is_some() || name == compact {
        return found;
    }
    find_exe(folder, name, APPX_EXE_DEPTH)
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

#[cfg(test)]
mod find_exe_tests {
    use super::find_exe;
    use std::path::Path;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    fn finds_exe_case_insensitively_within_depth() {
        let root = tempfile::tempdir().unwrap();
        let exe = root
            .path()
            .join("Vendor")
            .join("bin")
            .join("WezTerm-GUI.EXE");
        touch(&exe);

        assert_eq!(
            find_exe(root.path(), "wezterm", 2),
            Some(exe.to_string_lossy().into_owned())
        );
        assert_eq!(find_exe(root.path(), "wezterm", 1), None);
        assert_eq!(find_exe(root.path(), "wezterm", 0), None);
    }

    #[test]
    fn ignores_files_that_are_not_exe() {
        let root = tempfile::tempdir().unwrap();
        for name in ["notepad.txt", "notepad.exe.bak", "notepad.lnk"] {
            touch(&root.path().join(name));
        }
        assert_eq!(find_exe(root.path(), "notepad", 0), None);

        let exe = root.path().join("notepad.exe");
        touch(&exe);
        assert_eq!(
            find_exe(root.path(), "notepad", 0),
            Some(exe.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn prefers_an_exe_in_the_folder_over_one_in_a_subfolder() {
        let root = tempfile::tempdir().unwrap();
        // Several subfolders, so at least one is listed before `app.exe` whatever
        // order the filesystem returns.
        for folder in ["a-helpers", "bin", "helpers", "x64", "z-tools"] {
            touch(&root.path().join(folder).join("app-helper.exe"));
        }
        let exe = root.path().join("app.exe");
        touch(&exe);

        assert_eq!(
            find_exe(root.path(), "app", 2),
            Some(exe.to_string_lossy().into_owned())
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinked_folders() {
        let target = tempfile::tempdir().unwrap();
        touch(&target.path().join("app.exe"));
        let root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(target.path(), root.path().join("link")).unwrap();

        assert_eq!(find_exe(root.path(), "app", 3), None);
    }
}

#[cfg(test)]
mod appx_tests {
    use super::{cached_appx_packages, find_appx_exe, AppxPackages};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    fn touch(path: &std::path::Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    fn finds_the_exe_of_the_first_matching_package() {
        let root = tempfile::tempdir().unwrap();
        let store = root.path().join("store");
        let calc = root.path().join("calc");
        touch(&store.join("WinStore.App.exe"));
        let calc_exe = calc.join("VFS").join("bin").join("Calculator.exe");
        touch(&calc_exe);
        let packages: AppxPackages = vec![
            ("Microsoft.WindowsStore".into(), store),
            ("Microsoft.WindowsCalculator".into(), calc),
        ];

        let found = Some(calc_exe.to_string_lossy().into_owned());
        assert_eq!(find_appx_exe(&packages, "Calculator"), found);
        assert_eq!(find_appx_exe(&packages, "Calculator.EXE"), found);
        // The package matches without spaces; the exe is named with them.
        let spaced = root.path().join("calc").join("Windows Calculator.exe");
        touch(&spaced);
        std::fs::remove_file(&calc_exe).unwrap();
        assert_eq!(
            find_appx_exe(&packages, "Windows Calculator"),
            Some(spaced.to_string_lossy().into_owned())
        );

        assert_eq!(find_appx_exe(&packages, "Slack"), None);
        assert_eq!(find_appx_exe(&packages, " "), None);
        assert_eq!(find_appx_exe(&packages, ".exe"), None);
    }

    fn counting_listing<'a>(
        listings: &'a AtomicUsize,
        result: Result<AppxPackages, &'static str>,
    ) -> impl FnOnce() -> Result<AppxPackages, &'static str> + 'a {
        move || {
            listings.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(50));
            result
        }
    }

    fn one_package() -> AppxPackages {
        vec![("Pkg".to_string(), PathBuf::from("/pkg"))]
    }

    #[test]
    fn callers_at_the_same_time_share_one_listing() {
        let slot = Mutex::new(None);
        let listings = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..50 {
                scope.spawn(|| {
                    let list = counting_listing(&listings, Ok(one_package()));
                    let packages = cached_appx_packages(&slot, Duration::from_secs(60), list);
                    assert_eq!(packages[0].0, "Pkg");
                });
            }
        });
        assert_eq!(listings.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn lists_again_once_the_list_is_stale() {
        let slot = Mutex::new(None);
        let listings = AtomicUsize::new(0);
        for ttl in [
            Duration::from_secs(60),
            Duration::from_secs(60),
            Duration::ZERO,
        ] {
            cached_appx_packages(&slot, ttl, counting_listing(&listings, Ok(one_package())));
        }
        // The second call reused the list; the third found it stale.
        assert_eq!(listings.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_failed_listing_keeps_the_last_list_and_is_retried() {
        let slot = Mutex::new(None);
        let listings = AtomicUsize::new(0);
        let call =
            |ttl, result| cached_appx_packages(&slot, ttl, counting_listing(&listings, result));
        let ttl = Duration::from_secs(60);

        // A failure isn't cached, so the next call lists again.
        assert!(call(ttl, Err("package service unavailable")).is_empty());
        assert_eq!(call(ttl, Ok(one_package()))[0].0, "Pkg");
        // A failed refresh keeps the list that worked.
        assert_eq!(
            call(Duration::ZERO, Err("package service unavailable"))[0].0,
            "Pkg"
        );
        assert_eq!(listings.load(Ordering::SeqCst), 3);
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_icon_tests {
    use super::{find_appx_exe, find_exe, get_app_icon, get_exe_by_appx, list_appx_packages};

    #[tokio::test]
    async fn resolves_a_store_app() {
        let packages = list_appx_packages().unwrap();
        assert!(!packages.is_empty(), "no Store apps listed");
        // Any app whose exe is named after its package, such as
        // ShellExperienceHost.exe in Microsoft.Windows.ShellExperienceHost.
        let (name, exe) = packages
            .iter()
            .filter_map(|(_, folder)| std::fs::read_dir(folder).ok())
            .flat_map(|entries| entries.flatten())
            .filter_map(|entry| {
                let file = entry.file_name().to_string_lossy().to_lowercase();
                file.strip_suffix(".exe").map(str::to_string)
            })
            .find_map(|name| Some((name.clone(), find_appx_exe(&packages, &name)?)))
            .expect("no Store app is named after its package");
        eprintln!("{} packages; {name} -> {exe}", packages.len());

        assert_eq!(get_exe_by_appx(&name), Some(exe));
        let icon = get_app_icon(&name, None).await.unwrap().unwrap();
        assert!(icon.data.starts_with(b"\x89PNG"), "{name}");
    }

    #[tokio::test]
    async fn resolves_a_windows_tool() {
        assert!(find_exe(std::path::Path::new(r"C:\Windows"), "notepad", 0).is_some());
        let icon = get_app_icon("notepad", None).await.unwrap().unwrap();
        assert!(icon.data.starts_with(b"\x89PNG"));
    }
}
