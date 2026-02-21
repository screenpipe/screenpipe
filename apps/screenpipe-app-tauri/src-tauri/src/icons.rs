use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct AppIcon {
    pub data: Vec<u8>,
    pub path: Option<String>,
}

#[cfg(target_os = "macos")]
pub async fn get_app_icon(
    app_name: &str,
    app_path: Option<String>,
) -> Result<Option<AppIcon>, String> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSAutoreleasePool, NSData, NSString};
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

            let tiff_data: id = msg_send![icon, TIFFRepresentation];
            let image_rep: id = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff_data];
            let png_data: id = msg_send![image_rep, representationUsingType:0 properties:nil]; // Type 0 is PNG (supports transparency)

            let length = NSData::length(png_data);
            let bytes = NSData::bytes(png_data);
            let data = std::slice::from_raw_parts(bytes as *const u8, length as usize).to_vec();

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

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
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
                if let Ok(app_key) = key.open_subkey(&subkey) {
                    if let Ok(display_name) = app_key.get_value::<String, _>("DisplayName") {
                        if display_name
                            .to_lowercase()
                            .contains(&app_name.to_lowercase())
                        {
                            if let Ok(path) = app_key.get_value::<String, _>("DisplayIcon") {
                                let cleaned_path = path
                                    .split(',')
                                    .next()
                                    .unwrap_or(&path)
                                    .to_string()
                                    .trim_matches('"')
                                    .to_string();
                                return Some(cleaned_path);
                            } else if let Ok(path) = app_key.get_value::<String, _>("(default)") {
                                let cleaned_path = path
                                    .split(',')
                                    .next()
                                    .unwrap_or(&path)
                                    .to_string()
                                    .trim_matches('"')
                                    .to_string();
                                return Some(cleaned_path);
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
    let system_root =
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    std::path::PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

#[cfg(target_os = "windows")]
async fn get_exe_from_potential_path(app_name: &str) -> Option<String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let app_name = app_name.strip_suffix(".exe").unwrap_or(&app_name);
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
            if let icon_path = self.get_icon_path_from_name(app_name).await? {
                return self.load_icon_from_path(&icon_path);
            }

            Err(format!("Icon for App '{}' not found", app_name))
        }

        async fn get_icon_path_from_name(&self, icon_name: &str) -> Result<String, String> {
            let main_context = MainContext::default();
            let (sender, receiver) = futures_channel::oneshot::channel();
            {
                let icon_name = icon_name.to_string();

                MainContext::default().invoke(clone!(@strong icon_name => move || {
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
        app_path: Option<String>,
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
