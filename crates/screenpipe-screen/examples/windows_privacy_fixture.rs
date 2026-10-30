// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
#![cfg_attr(not(target_os = "windows"), allow(dead_code, unused_imports))]

#[cfg(target_os = "windows")]
mod windows_harness {
    use anyhow::Result;
    use std::{thread, time::Duration};
    use windows::{
        core::w,
        Win32::{
            Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM},
            Graphics::Gdi::{
                BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, HDC, PAINTSTRUCT,
            },
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetMessageW,
                LoadCursorW, RegisterClassW, ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW,
                IDC_ARROW, MSG, SW_SHOW, WINDOW_EX_STYLE, WINDOW_LONG_PTR_INDEX, WM_DESTROY,
                WM_PAINT, WM_PRINT, WM_PRINTCLIENT, WNDCLASSW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
            },
        },
    };

    const ALLOWED: COLORREF = COLORREF(0x00ff_ff00);
    const BLOCKED: COLORREF = COLORREF(0x00ff_00ff);

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: isize,
            insert_after: isize,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut paint);
                let color = if windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                    hwnd,
                    WINDOW_LONG_PTR_INDEX(0),
                ) == 1
                {
                    BLOCKED
                } else {
                    ALLOWED
                };
                let brush = CreateSolidBrush(color);
                FillRect(dc, &paint.rcPaint, brush);
                let _ = DeleteObject(brush);
                let _ = EndPaint(hwnd, &paint);
                LRESULT(0)
            }
            WM_PRINT | WM_PRINTCLIENT => {
                let mut client = RECT::default();
                let _ = GetClientRect(hwnd, &mut client);
                let color = if windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                    hwnd,
                    WINDOW_LONG_PTR_INDEX(0),
                ) == 1
                {
                    BLOCKED
                } else {
                    ALLOWED
                };
                let brush = CreateSolidBrush(color);
                FillRect(HDC(wparam.0 as *mut _), &client, brush);
                let _ = DeleteObject(brush);
                LRESULT(0)
            }
            WM_DESTROY => LRESULT(0),
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    pub fn run_window(blocked: bool, x: i32, y: i32) -> Result<()> {
        unsafe {
            let module = GetModuleHandleW(None).unwrap_or_default();
            let class_name = if blocked {
                w!("PrivacyBlockedFixture")
            } else {
                w!("PrivacyAllowedFixture")
            };
            let class = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(window_proc),
                cbWndExtra: std::mem::size_of::<isize>() as i32,
                hInstance: HINSTANCE(module.0),
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                lpszClassName: class_name,
                ..Default::default()
            };
            let _ = RegisterClassW(&class);
            let title = if blocked {
                "PrivacyBlocked"
            } else {
                "PrivacyAllowed"
            };
            let title_wide: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                class_name,
                windows::core::PCWSTR(title_wide.as_ptr()),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                x,
                y,
                520,
                420,
                None,
                None,
                HINSTANCE(module.0),
                None,
            )
            .unwrap_or_default();
            windows::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
                hwnd,
                WINDOW_LONG_PTR_INDEX(0),
                isize::from(blocked),
            );
            let _ = ShowWindow(hwnd, SW_SHOW);
            if blocked {
                let raw = hwnd.0 as usize;
                thread::spawn(move || loop {
                    // Keep the synthetic fixture above the test runner while
                    // still exercising both sides of the allowed window's Z order.
                    for (next_x, next_y, order) in [(220, 210, -1), (360, 300, -2)] {
                        let _ = SetWindowPos(
                            raw as isize,
                            order,
                            next_x,
                            next_y,
                            0,
                            0,
                            0x0001 | 0x0010,
                        );
                        thread::sleep(Duration::from_millis(15));
                    }
                });
            } else {
                let _ = SetWindowPos(hwnd.0 as isize, -1, x, y, 0, 0, 0x0001 | 0x0010);
            }
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let kind = args.next().ok_or_else(|| {
        anyhow::anyhow!("usage: windows_privacy_fixture <allowed|blocked> <x> <y>")
    })?;
    anyhow::ensure!(
        kind == "allowed" || kind == "blocked",
        "unknown fixture window"
    );
    let x = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("missing x"))?
        .parse()?;
    let y = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("missing y"))?
        .parse()?;
    windows_harness::run_window(kind == "blocked", x, y)
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("windows_privacy_fixture is Windows-only");
}
