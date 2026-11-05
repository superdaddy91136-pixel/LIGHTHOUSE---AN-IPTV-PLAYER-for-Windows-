use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener, Manager, State, Window, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PocStreamInfo {
    pub channel_id: i64,
    pub name: String,
    pub url: String,
    pub source_id: Option<i64>,
    pub user_agent: Option<String>,
    pub referrer: Option<String>,
    pub origin: Option<String>,
    #[serde(default)]
    pub ignore_ssl: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PocIpcCommand {
    pub command: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
}

#[derive(Clone)]
pub struct EmbeddedPocState {
    pub inner: Arc<Mutex<EmbeddedPocInner>>,
    pub active_pid: Arc<AtomicU32>,
    pub active_hwnd: Arc<AtomicUsize>,
    pub active_overlay_hwnd: Arc<AtomicUsize>,
    pub active_main_hwnd: Arc<AtomicUsize>,
}

pub struct EmbeddedPocInner {
    #[cfg(target_os = "windows")]
    pub child_hwnd: Option<usize>,
    #[cfg(target_os = "windows")]
    pub overlay_hwnd: Option<usize>,
    pub last_bounds: Option<(i32, i32, i32, i32)>,
    pub windowed_bounds: Option<(i32, i32, i32, i32)>,
    pub child_process: Option<Child>,
    pub child_pid: Option<u32>,
    pub ipc_tx: Option<mpsc::Sender<String>>,
    pub stream_info: Option<PocStreamInfo>,
    pub app_handle: Option<AppHandle>,
}

impl EmbeddedPocState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(EmbeddedPocInner {
                #[cfg(target_os = "windows")]
                child_hwnd: None,
                #[cfg(target_os = "windows")]
                overlay_hwnd: None,
                last_bounds: None,
                windowed_bounds: None,
                child_process: None,
                child_pid: None,
                ipc_tx: None,
                stream_info: None,
                app_handle: None,
            })),
            active_pid: Arc::new(AtomicU32::new(0)),
            active_hwnd: Arc::new(AtomicUsize::new(0)),
            active_overlay_hwnd: Arc::new(AtomicUsize::new(0)),
            active_main_hwnd: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn stop_sync(&self) {
        stop_embedded_player_sync(self);
    }

    pub fn sync_overlay_to_video(&self) {
        sync_overlay_to_video(self);
    }

    pub fn sync_overlay_position_to_main_window(&self) {
        self.sync_overlay_to_video();
    }

    pub fn handle_main_window_resized(&self, window: &Window) {
        #[cfg(target_os = "windows")]
        {
            let mut main_hwnd = self.active_main_hwnd.load(Ordering::SeqCst);
            if main_hwnd == 0 {
                if let Some(h) = find_main_window_hwnd() {
                    self.active_main_hwnd.store(h, Ordering::SeqCst);
                    main_hwnd = h;
                }
            }
            let overlay_hwnd = self.active_overlay_hwnd.load(Ordering::SeqCst);
            let child_hwnd = self.active_hwnd.load(Ordering::SeqCst);
            if main_hwnd == 0 || overlay_hwnd == 0 || child_hwnd == 0 {
                return;
            }

            unsafe {
                if win32::IsIconic(main_hwnd as win32::HWND) != 0 {
                    win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
                    return;
                }
            }

            let is_fs = window.is_fullscreen().unwrap_or(false);

            if is_fs {
                ACTIVE_IS_FULLSCREEN.store(true, Ordering::SeqCst);
                let crop_px = get_overlay_top_crop_px(overlay_hwnd);
                ACTIVE_TOP_CROP_PX.store(crop_px, Ordering::SeqCst);
                let _ = window.emit("overlay-top-crop", serde_json::json!({ "crop": OVERLAY_TOP_CROP_LOGICAL_PX }));

                let mut guard = None;
                for _ in 0..10 {
                    if let Ok(inner) = self.inner.try_lock() {
                        guard = Some(inner);
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }

                if let Some(mut inner) = guard {
                    // FULLSCREEN: Size directly from main client rect (GetClientRect) without waiting for Angular
                    let mut client_rc: win32::RECT = unsafe { std::mem::zeroed() };
                    unsafe {
                        win32::GetClientRect(main_hwnd as win32::HWND, &mut client_rc);
                    }
                    let client_w = client_rc.right - client_rc.left;
                    let client_h = client_rc.bottom - client_rc.top;

                    if client_w > 0 && client_h > 0 {
                        unsafe {
                            win32::SetWindowPos(
                                child_hwnd as win32::HWND,
                                win32::HWND_TOP,
                                0,
                                0,
                                client_w,
                                client_h,
                                win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW,
                            );
                            win32::UpdateWindow(child_hwnd as win32::HWND);
                        }

                        // Size overlay directly to client rect (fullscreen = no 2px inset)
                        sync_overlay_rect(main_hwnd, overlay_hwnd, 0, 0, client_w, client_h, true);

                        // Show overlay again after the single sync
                        ensure_overlay_borderless(overlay_hwnd);
                        unsafe {
                            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_SHOW);
                        }
                        apply_overlay_client_region(overlay_hwnd, Some(crop_px));

                        inner.last_bounds = Some((0, 0, client_w, client_h));
                    }
                }
            } else {
                ACTIVE_IS_FULLSCREEN.store(false, Ordering::SeqCst);
                let crop_px = get_overlay_top_crop_px(overlay_hwnd);
                ACTIVE_TOP_CROP_PX.store(crop_px, Ordering::SeqCst);
                let _ = window.emit("overlay-top-crop", serde_json::json!({ "crop": OVERLAY_TOP_CROP_LOGICAL_PX }));
                // WINDOWED MODE: Do NOT compute an overlay size from last_bounds/windowed_bounds.
                // Trigger the video resize path in Angular and sync overlay to current video rect.
                let _ = window.emit("sync-video-bounds", ());
                ensure_overlay_borderless(overlay_hwnd);
                self.sync_overlay_to_video();
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    pub fn handle_main_window_resized(&self, _window: &Window) {}

    pub fn hide_overlay(&self) {
        #[cfg(target_os = "windows")]
        {
            let overlay_hwnd = self.active_overlay_hwnd.load(Ordering::SeqCst);
            if overlay_hwnd != 0 {
                unsafe {
                    win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
                }
            }
        }
    }
}

impl Drop for EmbeddedPocInner {
    fn drop(&mut self) {
        if let Some(mut child) = self.child_process.take() {
            let _ = child.start_kill();
        }
        #[cfg(target_os = "windows")]
        if let Some(pid) = self.child_pid.take() {
            terminate_process_by_pid(pid);
        }
        #[cfg(target_os = "windows")]
        if let Some(hwnd) = self.child_hwnd.take() {
            destroy_child_window(hwnd);
        }
        #[cfg(target_os = "windows")]
        if let Some(overlay) = self.overlay_hwnd.take() {
            unsafe {
                win32::ShowWindow(overlay as win32::HWND, win32::SW_HIDE);
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub mod win32 {
    use std::ffi::c_void;

    pub type HWND = *mut c_void;
    pub type HINSTANCE = *mut c_void;
    pub type HMENU = *mut c_void;
    pub type HDC = *mut c_void;
    pub type HRGN = *mut c_void;
    pub type BOOL = i32;

    pub const WS_CHILD: u32 = 0x40000000;
    pub const WS_VISIBLE: u32 = 0x10000000;
    pub const WS_CLIPSIBLINGS: u32 = 0x04000000;
    pub const WS_CLIPCHILDREN: u32 = 0x02000000;
    pub const SWP_NOSIZE: u32 = 0x0001;
    pub const SWP_NOMOVE: u32 = 0x0002;
    pub const SWP_NOZORDER: u32 = 0x0004;
    pub const SWP_NOACTIVATE: u32 = 0x0010;
    pub const SWP_FRAMECHANGED: u32 = 0x0020;
    pub const SWP_SHOWWINDOW: u32 = 0x0040;
    pub const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
    pub const HWND_TOP: HWND = 0 as HWND;
    pub const HWND_BOTTOM: HWND = 1 as HWND;

    pub const GWL_STYLE: i32 = -16;
    pub const GWL_EXSTYLE: i32 = -20;
    pub const GWLP_HWNDPARENT: i32 = -8;
    pub const GW_CHILD: u32 = 5;

    pub const WS_POPUP: u32 = 0x80000000;
    pub const WS_BORDER: u32 = 0x00800000;
    pub const WS_DLGFRAME: u32 = 0x00400000;
    pub const WS_CAPTION: u32 = 0x00C00000;
    pub const WS_SYSMENU: u32 = 0x00080000;
    pub const WS_THICKFRAME: u32 = 0x00040000;
    pub const WS_SIZEBOX: u32 = 0x00040000;
    pub const WS_MINIMIZEBOX: u32 = 0x00020000;
    pub const WS_MAXIMIZEBOX: u32 = 0x00010000;

    pub const WS_EX_TRANSPARENT: u32 = 0x00000020;
    pub const WS_EX_NOACTIVATE: u32 = 0x08000000;

    pub const SW_HIDE: i32 = 0;
    pub const SW_SHOW: i32 = 5;
    pub const SW_SHOWNA: i32 = 8;

    pub const WM_SIZE: u32 = 0x0005;
    pub const WM_PAINT: u32 = 0x000F;
    pub const WM_CLOSE: u32 = 0x0010;
    pub const WM_ERASEBKGND: u32 = 0x0014;
    pub const WM_MOUSEACTIVATE: u32 = 0x0021;
    pub const WM_WINDOWPOSCHANGED: u32 = 0x0047;
    pub const WM_NCDESTROY: u32 = 0x0082;
    pub const WM_NCCALCSIZE: u32 = 0x0083;
    pub const WM_NCPAINT: u32 = 0x0085;
    pub const WM_NCACTIVATE: u32 = 0x0086;

    pub const MA_NOACTIVATE: i32 = 3;

    pub const CS_VREDRAW: u32 = 0x0001;
    pub const CS_HREDRAW: u32 = 0x0002;
    pub const CS_OWNDC: u32 = 0x0020;

    #[repr(C)]
    pub struct POINT {
        pub x: i32,
        pub y: i32,
    }

    #[repr(C)]
    pub struct RECT {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[repr(C)]
    pub struct PAINTSTRUCT {
        pub hdc: HDC,
        pub f_erase: BOOL,
        pub rc_paint: RECT,
        pub f_restore: BOOL,
        pub f_inc_update: BOOL,
        pub rgb_reserved: [u8; 32],
    }

    pub type WNDENUMPROC = Option<unsafe extern "system" fn(HWND, isize) -> BOOL>;
    pub type WNDPROC = Option<unsafe extern "system" fn(HWND, u32, usize, isize) -> isize>;

    #[repr(C)]
    pub struct WNDCLASSW {
        pub style: u32,
        pub lpfnWndProc: WNDPROC,
        pub cbClsExtra: i32,
        pub cbWndExtra: i32,
        pub hInstance: HINSTANCE,
        pub hIcon: *mut c_void,
        pub hCursor: *mut c_void,
        pub hbrBackground: *mut c_void,
        pub lpszMenuName: *const u16,
        pub lpszClassName: *const u16,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        pub fn RegisterClassW(lpWndClass: *const WNDCLASSW) -> u16;

        pub fn DefWindowProcW(
            hWnd: HWND,
            Msg: u32,
            wParam: usize,
            lParam: isize,
        ) -> isize;

        pub fn CreateWindowExW(
            dwExStyle: u32,
            lpClassName: *const u16,
            lpWindowName: *const u16,
            dwStyle: u32,
            X: i32,
            Y: i32,
            nWidth: i32,
            nHeight: i32,
            hWndParent: HWND,
            hMenu: HMENU,
            hInstance: HINSTANCE,
            lpParam: *mut c_void,
        ) -> HWND;

        pub fn DestroyWindow(hWnd: HWND) -> BOOL;

        pub fn SetWindowPos(
            hWnd: HWND,
            hWndInsertAfter: HWND,
            X: i32,
            Y: i32,
            cx: i32,
            cy: i32,
            uFlags: u32,
        ) -> BOOL;

        pub fn GetWindowLongW(hWnd: HWND, nIndex: i32) -> i32;
        pub fn SetWindowLongW(hWnd: HWND, nIndex: i32, dwNewLong: i32) -> i32;
        #[cfg(target_pointer_width = "64")]
        pub fn SetWindowLongPtrW(hWnd: HWND, nIndex: i32, dwNewLong: isize) -> isize;
        pub fn GetWindow(hWnd: HWND, uCmd: u32) -> HWND;

        pub fn EnumWindows(lpEnumFunc: WNDENUMPROC, lParam: isize) -> BOOL;
        pub fn GetWindowThreadProcessId(hWnd: HWND, lpdwProcessId: *mut u32) -> u32;
        pub fn IsWindowVisible(hWnd: HWND) -> BOOL;
        pub fn GetParent(hWnd: HWND) -> HWND;
        pub fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> HWND;

        pub fn BeginPaint(hWnd: HWND, lpPaint: *mut PAINTSTRUCT) -> HDC;
        pub fn EndPaint(hWnd: HWND, lpPaint: *const PAINTSTRUCT) -> BOOL;
        pub fn InvalidateRect(hWnd: HWND, lpRect: *const RECT, bErase: BOOL) -> BOOL;
        pub fn UpdateWindow(hWnd: HWND) -> BOOL;
        pub fn LoadCursorW(hInstance: HINSTANCE, lpCursorName: *const u16) -> *mut c_void;
        pub fn ClientToScreen(hWnd: HWND, lpPoint: *mut POINT) -> BOOL;
        pub fn ShowWindow(hWnd: HWND, nCmdShow: i32) -> BOOL;
        pub fn IsIconic(hWnd: HWND) -> BOOL;
        pub fn GetClientRect(hWnd: HWND, lpRect: *mut RECT) -> BOOL;
        pub fn GetWindowRect(hWnd: HWND, lpRect: *mut RECT) -> BOOL;
        pub fn SetWindowTextW(hWnd: HWND, lpString: *const u16) -> BOOL;
        pub fn SetWindowRgn(hWnd: HWND, hRgn: HRGN, bRedraw: BOOL) -> i32;
        pub fn AdjustWindowRectEx(
            lpRect: *mut RECT,
            dwStyle: u32,
            bMenu: BOOL,
            dwExStyle: u32,
        ) -> BOOL;
        pub fn GetDpiForWindow(hWnd: HWND) -> u32;
    }

    #[link(name = "gdi32")]
    unsafe extern "system" {
        pub fn CreateRectRgn(x1: i32, y1: i32, x2: i32, y2: i32) -> HRGN;
        pub fn DeleteObject(ho: *mut c_void) -> BOOL;
    }

    pub type SUBCLASSPROC = Option<
        unsafe extern "system" fn(
            hWnd: HWND,
            uMsg: u32,
            wParam: usize,
            lParam: isize,
            uIdSubclass: usize,
            dwRefData: usize,
        ) -> isize,
    >;

    #[link(name = "comctl32")]
    unsafe extern "system" {
        pub fn SetWindowSubclass(
            hWnd: HWND,
            pfnSubclass: SUBCLASSPROC,
            uIdSubclass: usize,
            dwRefData: usize,
        ) -> BOOL;

        pub fn RemoveWindowSubclass(
            hWnd: HWND,
            pfnSubclass: SUBCLASSPROC,
            uIdSubclass: usize,
        ) -> BOOL;

        pub fn DefSubclassProc(
            hWnd: HWND,
            uMsg: u32,
            wParam: usize,
            lParam: isize,
        ) -> isize;
    }

    #[allow(non_snake_case)]
    #[cfg(target_pointer_width = "32")]
    pub unsafe fn SetWindowLongPtrW(hWnd: HWND, nIndex: i32, dwNewLong: isize) -> isize {
        unsafe { SetWindowLongW(hWnd, nIndex, dwNewLong as i32) as isize }
    }

    pub const IDC_ARROW: *const u16 = 32512 as *const u16;

    pub const PROCESS_TERMINATE: u32 = 0x0001;
    pub const SYNCHRONIZE: u32 = 0x00100000;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn GetCurrentProcessId() -> u32;
        pub fn GetModuleHandleW(lpModuleName: *const u16) -> HINSTANCE;
        pub fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: BOOL, dwProcessId: u32) -> *mut c_void;
        pub fn TerminateProcess(hProcess: *mut c_void, uExitCode: u32) -> BOOL;
        pub fn WaitForSingleObject(hHandle: *mut c_void, dwMilliseconds: u32) -> u32;
        pub fn CloseHandle(hObject: *mut c_void) -> BOOL;
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn embed_wndproc(
    hwnd: win32::HWND,
    msg: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    unsafe {
        match msg {
            // Suppress background erase to avoid erasing D3D11 swapchain backbuffer
            win32::WM_ERASEBKGND => 1,
            win32::WM_PAINT => {
                let mut ps: win32::PAINTSTRUCT = std::mem::zeroed();
                let _ = win32::BeginPaint(hwnd, &mut ps);
                let _ = win32::EndPaint(hwnd, &ps);
                0
            }
            win32::WM_SIZE => {
                let child = win32::GetWindow(hwnd, win32::GW_CHILD);
                if !child.is_null() {
                    let w = (lparam & 0xFFFF) as i32;
                    let h = ((lparam >> 16) & 0xFFFF) as i32;
                    win32::SetWindowPos(
                        child,
                        std::ptr::null_mut(),
                        0,
                        0,
                        w,
                        h,
                        win32::SWP_NOZORDER | win32::SWP_NOACTIVATE | win32::SWP_ASYNCWINDOWPOS,
                    );
                }
                win32::DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            win32::WM_CLOSE => {
                win32::DestroyWindow(hwnd);
                0
            }
            _ => win32::DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

#[cfg(target_os = "windows")]
pub fn register_embed_class() {
    static REGISTERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !REGISTERED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        let class_name: Vec<u16> = "LighthouseMpvEmbedClass\0".encode_utf16().collect();
        let hinstance = unsafe { win32::GetModuleHandleW(std::ptr::null()) };
        let hcursor = unsafe { win32::LoadCursorW(std::ptr::null_mut(), win32::IDC_ARROW) };
        let wc = win32::WNDCLASSW {
            style: win32::CS_HREDRAW | win32::CS_VREDRAW | win32::CS_OWNDC,
            lpfnWndProc: Some(embed_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            hCursor: hcursor,
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        unsafe {
            win32::RegisterClassW(&wc);
        }
    }
}

#[cfg(target_os = "windows")]
pub fn find_main_window_hwnd() -> Option<usize> {
    struct Search {
        target_pid: u32,
        found_hwnd: usize,
    }
    unsafe extern "system" fn enum_proc(hwnd: win32::HWND, lparam: isize) -> win32::BOOL {
        let search = unsafe { &mut *(lparam as *mut Search) };
        let mut pid: u32 = 0;
        unsafe {
            win32::GetWindowThreadProcessId(hwnd, &mut pid);
        }
        if pid == search.target_pid && unsafe { win32::IsWindowVisible(hwnd) } != 0 {
            let parent = unsafe { win32::GetParent(hwnd) };
            if parent.is_null() {
                search.found_hwnd = hwnd as usize;
                return 0; // stop enumeration
            }
        }
        1 // continue enumeration
    }
    let mut search = Search {
        target_pid: unsafe { win32::GetCurrentProcessId() },
        found_hwnd: 0,
    };
    unsafe {
        win32::EnumWindows(Some(enum_proc), &mut search as *mut _ as isize);
    }
    if search.found_hwnd != 0 {
        Some(search.found_hwnd)
    } else {
        // Fallback: search by known window title prefix
        let title: Vec<u16> = "Lighthouse\0".encode_utf16().collect();
        let fallback = unsafe { win32::FindWindowW(std::ptr::null(), title.as_ptr()) };
        if !fallback.is_null() {
            Some(fallback as usize)
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
pub fn create_child_window(
    parent_hwnd_usize: usize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    _z_order: &str,
) -> Result<usize, String> {
    let parent_hwnd = parent_hwnd_usize as win32::HWND;

    // Register our custom embed window class
    register_embed_class();

    let custom_class: Vec<u16> = "LighthouseMpvEmbedClass\0".encode_utf16().collect();
    let static_class: Vec<u16> = "STATIC\0".encode_utf16().collect();
    let win_name: Vec<u16> = "LighthouseMpvEmbed\0".encode_utf16().collect();

    // Use WS_CLIPCHILDREN | WS_CLIPSIBLINGS so parent/child repaints never clash with MPV
    let style = win32::WS_CHILD | win32::WS_VISIBLE | win32::WS_CLIPSIBLINGS | win32::WS_CLIPCHILDREN;
    let hinstance = unsafe { win32::GetModuleHandleW(std::ptr::null()) };

    // No extended styles needed; window is fully opaque and handles its own mouse input
    let ex_style = 0;

    let mut child_hwnd = unsafe {
        win32::CreateWindowExW(
            ex_style,
            custom_class.as_ptr(),
            win_name.as_ptr(),
            style,
            x,
            y,
            width,
            height,
            parent_hwnd,
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null_mut(),
        )
    };

    if child_hwnd.is_null() {
        child_hwnd = unsafe {
            win32::CreateWindowExW(
                ex_style,
                static_class.as_ptr(),
                win_name.as_ptr(),
                style,
                x,
                y,
                width,
                height,
                parent_hwnd,
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null_mut(),
            )
        };
    }

    if child_hwnd.is_null() {
        return Err("CreateWindowExW returned NULL".to_string());
    }

    // Must be positioned at HWND_TOP so it renders in front of sibling WebView2
    unsafe {
        win32::SetWindowPos(
            child_hwnd,
            win32::HWND_TOP,
            x,
            y,
            width,
            height,
            win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW | win32::SWP_ASYNCWINDOWPOS,
        );
        win32::UpdateWindow(child_hwnd);
    }

    Ok(child_hwnd as usize)
}

#[cfg(target_os = "windows")]
pub fn destroy_child_window(hwnd_usize: usize) {
    if hwnd_usize == 0 {
        return;
    }
    let hwnd = hwnd_usize as win32::HWND;
    unsafe {
        let _ = win32::DestroyWindow(hwnd);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn destroy_child_window(_hwnd_usize: usize) {}

#[cfg(target_os = "windows")]
pub fn terminate_process_by_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    unsafe {
        let handle = win32::OpenProcess(
            win32::PROCESS_TERMINATE | win32::SYNCHRONIZE,
            0,
            pid,
        );
        if !handle.is_null() {
            let _ = win32::TerminateProcess(handle, 1);
            let _ = win32::WaitForSingleObject(handle, 1000);
            let _ = win32::CloseHandle(handle);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn terminate_process_by_pid(_pid: u32) {}

#[cfg(target_os = "windows")]
pub fn inspect_and_clean_overlay_exstyle(_stage: &str, overlay_hwnd: usize) {
    if overlay_hwnd == 0 {
        return;
    }
    unsafe {
        let cur_ex = win32::GetWindowLongW(overlay_hwnd as win32::HWND, win32::GWL_EXSTYLE);
        let has_transparent = (cur_ex & (win32::WS_EX_TRANSPARENT as i32)) != 0;
        let has_noactivate = (cur_ex & (win32::WS_EX_NOACTIVATE as i32)) != 0;

        // Strip WS_EX_TRANSPARENT and WS_EX_NOACTIVATE if present. Do NOT force WS_EX_LAYERED.
        // Rely exclusively on Tauri's transparent window configuration to ensure WebView2 receives mouse input.
        let mut clean_ex = cur_ex;
        if has_transparent {
            clean_ex &= !(win32::WS_EX_TRANSPARENT as i32);
        }
        if has_noactivate {
            clean_ex &= !(win32::WS_EX_NOACTIVATE as i32);
        }
        if clean_ex != cur_ex {
            win32::SetWindowLongW(overlay_hwnd as win32::HWND, win32::GWL_EXSTYLE, clean_ex);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn inspect_and_clean_overlay_exstyle(_stage: &str, _overlay_hwnd: usize) {}

pub const OVERLAY_TOP_CROP_LOGICAL_PX: i32 = 32;

#[cfg(target_os = "windows")]
pub static ACTIVE_TOP_CROP_PX: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[cfg(target_os = "windows")]
pub static ACTIVE_IS_FULLSCREEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
pub fn get_overlay_top_crop_px(overlay_hwnd: usize) -> i32 {
    if overlay_hwnd == 0 {
        return 0;
    }
    let dpi = unsafe { win32::GetDpiForWindow(overlay_hwnd as win32::HWND) };
    let scale = if dpi > 0 { dpi as f64 / 96.0 } else { 1.0 };
    (OVERLAY_TOP_CROP_LOGICAL_PX as f64 * scale).round() as i32
}

#[cfg(not(target_os = "windows"))]
pub fn get_overlay_top_crop_px(_overlay_hwnd: usize) -> i32 {
    0
}

pub fn get_current_logical_top_crop() -> i32 {
    #[cfg(target_os = "windows")]
    {
        OVERLAY_TOP_CROP_LOGICAL_PX
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
}

#[tauri::command]
pub fn get_overlay_top_crop() -> i32 {
    get_current_logical_top_crop()
}

#[cfg(target_os = "windows")]
static IN_APPLY_REGION: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
pub fn apply_overlay_client_region(overlay_hwnd: usize, crop_param: Option<i32>) {
    if overlay_hwnd == 0 {
        return;
    }
    if IN_APPLY_REGION.swap(true, Ordering::SeqCst) {
        return;
    }
    let crop_px = match crop_param {
        Some(c) => {
            ACTIVE_TOP_CROP_PX.store(c, Ordering::SeqCst);
            c
        }
        None => {
            let saved = ACTIVE_TOP_CROP_PX.load(Ordering::SeqCst);
            if saved != 0 {
                saved
            } else {
                let computed = get_overlay_top_crop_px(overlay_hwnd);
                ACTIVE_TOP_CROP_PX.store(computed, Ordering::SeqCst);
                computed
            }
        }
    };

    unsafe {
        let hwnd = overlay_hwnd as win32::HWND;
        let mut win_rc: win32::RECT = std::mem::zeroed();
        let mut client_rc: win32::RECT = std::mem::zeroed();
        if win32::GetWindowRect(hwnd, &mut win_rc) != 0 && win32::GetClientRect(hwnd, &mut client_rc) != 0 {
            let client_w = client_rc.right - client_rc.left;
            let client_h = client_rc.bottom - client_rc.top;
            if client_w > 0 && client_h > crop_px {
                let rgn = win32::CreateRectRgn(0, crop_px, client_w, client_h);
                if !rgn.is_null() {
                    let res = win32::SetWindowRgn(hwnd, rgn, 1);
                    if res == 0 {
                        win32::DeleteObject(rgn);
                    }
                }
            }
        }
    }
    IN_APPLY_REGION.store(false, Ordering::SeqCst);
}

#[cfg(not(target_os = "windows"))]
pub fn apply_overlay_client_region(_overlay_hwnd: usize, _crop_param: Option<i32>) {}

#[cfg(target_os = "windows")]
pub fn ensure_overlay_borderless(overlay_hwnd: usize) {
    if overlay_hwnd == 0 {
        return;
    }
    unsafe {
        let cur_style = win32::GetWindowLongW(overlay_hwnd as win32::HWND, win32::GWL_STYLE) as u32;
        let remove_mask = win32::WS_CAPTION
            | win32::WS_BORDER
            | win32::WS_DLGFRAME
            | win32::WS_THICKFRAME
            | win32::WS_SIZEBOX
            | win32::WS_SYSMENU
            | win32::WS_MINIMIZEBOX
            | win32::WS_MAXIMIZEBOX;
        let clean_style = (cur_style & !remove_mask) | win32::WS_POPUP;

        if clean_style == cur_style {
            apply_overlay_client_region(overlay_hwnd, None);
            return;
        }

        win32::SetWindowLongPtrW(
            overlay_hwnd as win32::HWND,
            win32::GWL_STYLE,
            clean_style as isize,
        );

        win32::SetWindowPos(
            overlay_hwnd as win32::HWND,
            win32::HWND_TOP,
            0,
            0,
            0,
            0,
            win32::SWP_FRAMECHANGED
                | win32::SWP_NOMOVE
                | win32::SWP_NOSIZE
                | win32::SWP_NOZORDER
                | win32::SWP_NOACTIVATE,
        );
        apply_overlay_client_region(overlay_hwnd, None);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_overlay_borderless(_overlay_hwnd: usize) {}

pub fn ensure_overlay_borderless_by_window(window: &Window) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(raw) = window.hwnd() {
            let h = raw.0 as usize;
            ensure_overlay_borderless(h);
            apply_overlay_client_region(h, None);
        }
    }
}

#[cfg(target_os = "windows")]
pub const OVERLAY_SUBCLASS_ID: usize = 0x4F564C59; // 'OVLY'

#[cfg(target_os = "windows")]
unsafe extern "system" fn overlay_subclass_proc(
    hwnd: win32::HWND,
    msg: u32,
    wparam: usize,
    lparam: isize,
    uid_subclass: usize,
    _ref_data: usize,
) -> isize {
    unsafe {
        match msg {
            win32::WM_NCCALCSIZE => {
                // When wParam is TRUE (non-zero), return 0 so the window has no non-client area at all.
                if wparam != 0 {
                    return 0;
                }
                win32::DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            win32::WM_ERASEBKGND => {
                // Suppress background erase so Windows GDI does not paint a background brush over transparent webview
                1
            }
            win32::WM_NCPAINT => {
                // Suppress non-client frame painting completely.
                0
            }
            win32::WM_NCACTIVATE => {
                // Prevent Windows from repainting the non-client caption upon window activation.
                // DefSubclassProc with lParam = -1 tells Windows not to repaint the non-client area.
                win32::DefSubclassProc(hwnd, msg, wparam, -1);
                1
            }
            win32::WM_MOUSEACTIVATE => {
                // Return MA_NOACTIVATE (3) so clicks reach webview controls without activating the window.
                win32::MA_NOACTIVATE as isize
            }
            win32::WM_WINDOWPOSCHANGED => {
                let res = win32::DefSubclassProc(hwnd, msg, wparam, lparam);
                apply_overlay_client_region(hwnd as usize, None);
                res
            }
            win32::WM_SIZE => {
                let res = win32::DefSubclassProc(hwnd, msg, wparam, lparam);
                apply_overlay_client_region(hwnd as usize, None);
                res
            }
            win32::WM_NCDESTROY => {
                // Automatically clean up subclass on window destruction.
                win32::RemoveWindowSubclass(hwnd, Some(overlay_subclass_proc), uid_subclass);
                win32::DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            _ => win32::DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }
}

#[cfg(target_os = "windows")]
pub fn install_overlay_subclass(overlay_hwnd: usize) {
    if overlay_hwnd == 0 {
        return;
    }
    unsafe {
        // Ensure not installed twice by removing any existing instance first
        win32::RemoveWindowSubclass(
            overlay_hwnd as win32::HWND,
            Some(overlay_subclass_proc),
            OVERLAY_SUBCLASS_ID,
        );
        let _ = win32::SetWindowSubclass(
            overlay_hwnd as win32::HWND,
            Some(overlay_subclass_proc),
            OVERLAY_SUBCLASS_ID,
            0,
        );
        let empty: [u16; 1] = [0];
        win32::SetWindowTextW(overlay_hwnd as win32::HWND, empty.as_ptr());
    }
}

#[cfg(not(target_os = "windows"))]
pub fn install_overlay_subclass(_overlay_hwnd: usize) {}

#[cfg(target_os = "windows")]
pub fn remove_overlay_subclass(overlay_hwnd: usize) {
    if overlay_hwnd == 0 {
        return;
    }
    unsafe {
        win32::RemoveWindowSubclass(
            overlay_hwnd as win32::HWND,
            Some(overlay_subclass_proc),
            OVERLAY_SUBCLASS_ID,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub fn remove_overlay_subclass(_overlay_hwnd: usize) {}

#[cfg(target_os = "windows")]
pub fn ensure_overlay_ownership(main_hwnd: usize, overlay_hwnd: usize) {
    if main_hwnd == 0 || overlay_hwnd == 0 {
        return;
    }
    unsafe {
        win32::SetWindowLongPtrW(
            overlay_hwnd as win32::HWND,
            win32::GWLP_HWNDPARENT,
            main_hwnd as isize,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_overlay_ownership(_main_hwnd: usize, _overlay_hwnd: usize) {}

#[cfg(target_os = "windows")]
pub fn sync_overlay_to_video(state: &EmbeddedPocState) {
    let mut main_hwnd = state.active_main_hwnd.load(Ordering::SeqCst);
    if main_hwnd == 0 {
        if let Some(h) = find_main_window_hwnd() {
            state.active_main_hwnd.store(h, Ordering::SeqCst);
            main_hwnd = h;
        }
    }
    let overlay_hwnd = state.active_overlay_hwnd.load(Ordering::SeqCst);
    let child_hwnd = state.active_hwnd.load(Ordering::SeqCst);

    if main_hwnd == 0 || overlay_hwnd == 0 || child_hwnd == 0 {
        return;
    }

    unsafe {
        if win32::IsIconic(main_hwnd as win32::HWND) != 0 {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
            return;
        }

        let mut video_rc: win32::RECT = std::mem::zeroed();
        let ok = win32::GetWindowRect(child_hwnd as win32::HWND, &mut video_rc);
        if ok == 0 {
            return;
        }

        let video_w = video_rc.right - video_rc.left;
        let video_h = video_rc.bottom - video_rc.top;
        if video_w <= 0 || video_h <= 0 {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
            return;
        }

        let is_fs = if let Ok(inner) = state.inner.try_lock() {
            if let Some(ref app) = inner.app_handle {
                app.get_webview_window("main")
                    .and_then(|w| w.is_fullscreen().ok())
                    .unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        };

        ACTIVE_IS_FULLSCREEN.store(is_fs, Ordering::SeqCst);
        let crop_px = get_overlay_top_crop_px(overlay_hwnd);
        ACTIVE_TOP_CROP_PX.store(crop_px, Ordering::SeqCst);

        let (overlay_x, overlay_y, overlay_w, overlay_h) = if is_fs {
            (
                video_rc.left,
                video_rc.top - crop_px,
                video_w,
                video_h + crop_px,
            )
        } else {
            const INSET: i32 = 2;
            let base_x = video_rc.left + INSET;
            let base_y = video_rc.top + INSET;
            let base_w = (video_w - INSET * 2).max(0);
            let base_h = (video_h - INSET * 2).max(0);
            (
                base_x,
                base_y - crop_px,
                base_w,
                base_h + crop_px,
            )
        };

        if overlay_w <= 0 || overlay_h <= 0 {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
            return;
        }

        ensure_overlay_borderless(overlay_hwnd);
        inspect_and_clean_overlay_exstyle("sync", overlay_hwnd);

        let (win_x, win_y, win_w, win_h) = {
            let mut adj_rc = win32::RECT {
                left: overlay_x,
                top: overlay_y,
                right: overlay_x + overlay_w,
                bottom: overlay_y + overlay_h,
            };
            let cur_style = win32::GetWindowLongW(overlay_hwnd as win32::HWND, win32::GWL_STYLE) as u32;
            let cur_ex_style = win32::GetWindowLongW(overlay_hwnd as win32::HWND, win32::GWL_EXSTYLE) as u32;
            if win32::AdjustWindowRectEx(&mut adj_rc, cur_style, 0, cur_ex_style) != 0 {
                (
                    overlay_x,
                    adj_rc.top,
                    overlay_w,
                    adj_rc.bottom - adj_rc.top,
                )
            } else {
                (overlay_x, overlay_y, overlay_w, overlay_h)
            }
        };

        win32::SetWindowPos(
            overlay_hwnd as win32::HWND,
            win32::HWND_TOP,
            win_x,
            win_y,
            win_w,
            win_h,
            win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW,
        );
        apply_overlay_client_region(overlay_hwnd, Some(crop_px));

        if let Ok(inner) = state.inner.try_lock() {
            if let Some(ref app) = inner.app_handle {
                let _ = app.emit("overlay-top-crop", serde_json::json!({ "crop": OVERLAY_TOP_CROP_LOGICAL_PX }));
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sync_overlay_to_video(_state: &EmbeddedPocState) {}

#[cfg(target_os = "windows")]
pub fn sync_overlay_rect(
    main_hwnd: usize,
    overlay_hwnd: usize,
    mut x: i32,
    mut y: i32,
    mut width: i32,
    mut height: i32,
    is_fullscreen: bool,
) {
    if main_hwnd == 0 || overlay_hwnd == 0 || width <= 0 || height <= 0 {
        return;
    }
    unsafe {
        if win32::IsIconic(main_hwnd as win32::HWND) != 0 {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
            return;
        }

        // 1. Get client area of main window
        let mut client_rc: win32::RECT = std::mem::zeroed();
        win32::GetClientRect(main_hwnd as win32::HWND, &mut client_rc);
        let client_w = client_rc.right - client_rc.left;
        let client_h = client_rc.bottom - client_rc.top;

        let crop_px = get_overlay_top_crop_px(overlay_hwnd);
        ACTIVE_IS_FULLSCREEN.store(is_fullscreen, Ordering::SeqCst);
        ACTIVE_TOP_CROP_PX.store(crop_px, Ordering::SeqCst);

        // 2. Safety bounds:
        // Keep the 2px inset ONLY in windowed mode. In fullscreen, fill the full client rect without inset.
        if !is_fullscreen {
            const INSET: i32 = 2;
            if x < INSET {
                width -= INSET - x;
                x = INSET;
            }
            if y < INSET {
                height -= INSET - y;
                y = INSET;
            }
            if client_w > 0 && x + width > client_w - INSET {
                width = (client_w - INSET - x).max(0);
            }
            if client_h > 0 && y + height > client_h - INSET {
                height = (client_h - INSET - y).max(0);
            }
        }

        if width <= 0 || height <= 0 {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
            return;
        }

        // 3. Convert (x, y) from client coordinates to physical screen coordinates
        let mut pt = win32::POINT { x, y };
        win32::ClientToScreen(main_hwnd as win32::HWND, &mut pt);

        let target_x = pt.x;
        let target_y = pt.y - crop_px;
        let target_w = width;
        let target_h = height + crop_px;

        // 4. Ensure overlay is borderless and WS_EX_TRANSPARENT/NOACTIVATE are cleared
        ensure_overlay_borderless(overlay_hwnd);
        inspect_and_clean_overlay_exstyle("sync", overlay_hwnd);

        let (win_x, win_y, win_w, win_h) = {
            let mut adj_rc = win32::RECT {
                left: target_x,
                top: target_y,
                right: target_x + target_w,
                bottom: target_y + target_h,
            };
            let cur_style = win32::GetWindowLongW(overlay_hwnd as win32::HWND, win32::GWL_STYLE) as u32;
            let cur_ex_style = win32::GetWindowLongW(overlay_hwnd as win32::HWND, win32::GWL_EXSTYLE) as u32;
            if win32::AdjustWindowRectEx(&mut adj_rc, cur_style, 0, cur_ex_style) != 0 {
                (
                    target_x,
                    adj_rc.top,
                    target_w,
                    adj_rc.bottom - adj_rc.top,
                )
            } else {
                (target_x, target_y, target_w, target_h)
            }
        };

        win32::SetWindowPos(
            overlay_hwnd as win32::HWND,
            win32::HWND_TOP,
            win_x,
            win_y,
            win_w,
            win_h,
            win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW,
        );
        apply_overlay_client_region(overlay_hwnd, Some(crop_px));
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sync_overlay_rect(
    _main_hwnd: usize,
    _overlay_hwnd: usize,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
    _is_fullscreen: bool,
) {}

pub fn init_overlay_window(app: &AppHandle) {
    let app_handle_for_crop = app.clone();
    let _ = app.listen("request-overlay-top-crop", move |_| {
        let logical_crop = get_current_logical_top_crop();
        let _ = app_handle_for_crop.emit("overlay-top-crop", serde_json::json!({ "crop": logical_crop }));
    });

    #[cfg(target_os = "windows")]
    {
        if let Some(overlay_win) = app.get_webview_window("player-overlay") {
            let _ = overlay_win.set_ignore_cursor_events(false);
            let _ = overlay_win.set_decorations(false);
            let _ = overlay_win.set_resizable(false);
            let _ = overlay_win.set_title("");
            if let Ok(overlay_raw) = overlay_win.hwnd() {
                let overlay_hwnd = overlay_raw.0 as usize;
                let main_hwnd = app
                    .get_webview_window("main")
                    .and_then(|w| w.hwnd().ok().map(|h| h.0 as usize))
                    .or_else(find_main_window_hwnd)
                    .unwrap_or(0);

                if main_hwnd != 0 && overlay_hwnd != 0 {
                    ensure_overlay_ownership(main_hwnd, overlay_hwnd);
                }

                install_overlay_subclass(overlay_hwnd);
                ensure_overlay_borderless(overlay_hwnd);
                inspect_and_clean_overlay_exstyle("init", overlay_hwnd);
                apply_overlay_client_region(overlay_hwnd, None);

                if let Some(state) = app.try_state::<EmbeddedPocState>() {
                    state.active_overlay_hwnd.store(overlay_hwnd, Ordering::SeqCst);
                    if main_hwnd != 0 {
                        state.active_main_hwnd.store(main_hwnd, Ordering::SeqCst);
                    }
                }

                unsafe {
                    win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
                }
            }
        }
    }
}

pub fn stop_embedded_player_sync(state: &EmbeddedPocState) {
    let atomic_pid = state.active_pid.swap(0, Ordering::SeqCst);
    let atomic_hwnd = state.active_hwnd.swap(0, Ordering::SeqCst);

    let overlay_hwnd = state.active_overlay_hwnd.load(Ordering::SeqCst);
    if overlay_hwnd != 0 {
        #[cfg(target_os = "windows")]
        unsafe {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
        }
    }

    let (child_opt, child_pid, hwnd_opt, app_opt) = {
        if let Ok(mut inner) = state.inner.try_lock() {
            let child = inner.child_process.take();
            let pid = inner.child_pid.take();
            #[cfg(target_os = "windows")]
            let hwnd = inner.child_hwnd.take();
            #[cfg(not(target_os = "windows"))]
            let hwnd: Option<usize> = None;
            let app = inner.app_handle.take();
            inner.ipc_tx = None;
            inner.stream_info = None;
            inner.last_bounds = None;
            inner.windowed_bounds = None;
            #[cfg(target_os = "windows")]
            {
                inner.overlay_hwnd = None;
            }
            (child, pid, hwnd, app)
        } else {
            (None, None, None, None)
        }
    };

    if let Some(mut child) = child_opt {
        let _ = child.start_kill();
    }

    let target_pid = child_pid.or(if atomic_pid != 0 { Some(atomic_pid) } else { None });
    if let Some(pid) = target_pid {
        terminate_process_by_pid(pid);
    }

    let target_hwnd = hwnd_opt.or(if atomic_hwnd != 0 { Some(atomic_hwnd) } else { None });
    if let Some(hwnd) = target_hwnd {
        destroy_child_window(hwnd);
    }

    if let Some(ref app) = app_opt {
        if let Some(main_win) = app.get_webview_window("main") {
            if main_win.is_fullscreen().unwrap_or(false) {
                let _ = main_win.set_fullscreen(false);
                let _ = app.emit("player-fullscreen-changed", false);
            }
        }
        if let Some(overlay_win) = app.get_webview_window("player-overlay") {
            let _ = overlay_win.hide();
        }
        #[cfg(target_os = "windows")]
        {
            ACTIVE_IS_FULLSCREEN.store(false, Ordering::SeqCst);
            ACTIVE_TOP_CROP_PX.store(0, Ordering::SeqCst);
        }
        let _ = app.emit("overlay-top-crop", serde_json::json!({ "crop": OVERLAY_TOP_CROP_LOGICAL_PX }));
        let _ = app.emit("embedded-poc-stopped", ());
    }
}

pub fn build_stream_info(
    channel_id: i64,
    name: String,
    url: String,
    source_id: Option<i64>,
) -> Result<PocStreamInfo, String> {
    let headers = crate::sql::get_channel_headers_by_id(channel_id).ok().flatten();
    let source = source_id.and_then(|id| crate::sql::get_source_from_id(id).ok());
    let user_agent = headers.as_ref().and_then(|h| h.user_agent.clone())
        .or_else(|| source.as_ref().and_then(|s| s.stream_user_agent.clone()));
    let referrer = headers.as_ref().and_then(|h| h.referrer.clone());
    let origin = headers.as_ref().and_then(|h| h.http_origin.clone());
    let ignore_ssl = headers.as_ref().and_then(|h| h.ignore_ssl);

    Ok(PocStreamInfo {
        channel_id,
        name,
        url,
        source_id,
        user_agent,
        referrer,
        origin,
        ignore_ssl,
    })
}

pub fn build_stream_info_from_channel(channel: &crate::types::Channel) -> Result<PocStreamInfo, String> {
    let channel_id = channel.id.ok_or_else(|| "Channel has no ID".to_string())?;
    let (url, name, source_id) = if let Some(ref u) = channel.url {
        (u.clone(), channel.name.clone(), channel.source_id)
    } else {
        let conn = crate::sql::get_conn().map_err(|e| format!("{:?}", e))?;
        let row = conn
            .query_row(
                "SELECT url, name, source_id FROM channels WHERE id = ?1",
                [channel_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?)),
            )
            .map_err(|e| format!("Channel not found: {:?}", e))?;
        (row.0, row.1, row.2)
    };
    build_stream_info(channel_id, name, url, source_id)
}

pub fn build_embedded_mpv_args(
    child_hwnd: usize,
    pipe_name: &str,
    stream: &PocStreamInfo,
) -> Vec<String> {
    let mut args = Vec::new();
    args.push(format!("--wid={}", child_hwnd));
    args.push(format!("--input-ipc-server={}", pipe_name));
    args.push("--vo=gpu-next".to_string());
    args.push("--gpu-context=d3d11".to_string());
    args.push("--hwdec=auto".to_string());
    args.push("--msg-level=all=error".to_string());
    args.push("--input-default-bindings=no".to_string());
    args.push("--input-vo-keyboard=no".to_string());
    args.push("--input-cursor=no".to_string());
    args.push("--cursor-autohide=no".to_string());
    args.push("--no-terminal".to_string());
    args.push("--osc=no".to_string());
    args.push("--save-position-on-quit".to_string());

    if let Some(ref ua) = stream.user_agent {
        args.push(format!("--user-agent={}", ua));
    }
    let mut headers_vec = Vec::new();
    if let Some(ref orig) = stream.origin {
        headers_vec.push(format!("origin:{}", orig));
    }
    if let Some(ref refer) = stream.referrer {
        headers_vec.push(format!("referer:{}", refer));
    }
    if !headers_vec.is_empty() {
        args.push(format!("--http-header-fields={}", headers_vec.join(",")));
    }
    if stream.ignore_ssl == Some(true) {
        args.push("--ytdl-raw-options=no-check-certificates=True".to_string());
    }

    if let Ok(settings) = crate::settings::get_settings() {
        if settings.use_stream_caching == Some(false) {
            args.push("--cache=no".to_string());
        }
        if let Some(volume) = settings.volume {
            args.push(format!("--volume={}", volume));
        }
        if let Some(ref mpv_params) = settings.mpv_params {
            #[cfg(not(target_os = "windows"))]
            if let Ok(params) = shell_words::split(mpv_params) {
                args.extend(params);
            }
            #[cfg(target_os = "windows")]
            {
                let params = winsplit::split(mpv_params);
                args.extend(params);
            }
        }
    }

    args.push(stream.url.clone());
    args
}

pub async fn start_embedded_player_internal(
    window: WebviewWindow,
    stream: PocStreamInfo,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    z_order: Option<String>,
    state: State<'_, EmbeddedPocState>,
) -> Result<PocStreamInfo, String> {
    // 1. Clean up any previous embedded playback
    stop_embedded_poc_internal(&state).await;

    #[cfg(not(target_os = "windows"))]
    {
        return Err("Embedded Win32 player is currently supported on Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ClientOptions;

        // 2. Find top-level Lighthouse HWND and create child HWND ON THE MAIN UI THREAD
        let z_order_val = z_order.unwrap_or_else(|| "top".to_string());
        let (tx_hwnd, rx_hwnd) = tokio::sync::oneshot::channel();
        let window_clone = window.clone();
        let z_order_for_create = z_order_val.clone();

        window
            .run_on_main_thread(move || {
                let parent_hwnd = window_clone
                    .hwnd()
                    .map(|h| h.0 as usize)
                    .or_else(|_| find_main_window_hwnd().ok_or(()))
                    .unwrap_or(0);

                if parent_hwnd == 0 {
                    let _ = tx_hwnd.send(Err("Could not locate Lighthouse top-level HWND".to_string()));
                    return;
                }

                // Ensure parent window clips children so repainting/resizing never causes DWM / swapchain deadlock
                unsafe {
                    let cur_style = win32::GetWindowLongW(parent_hwnd as win32::HWND, win32::GWL_STYLE);
                    win32::SetWindowLongW(
                        parent_hwnd as win32::HWND,
                        win32::GWL_STYLE,
                        cur_style | (win32::WS_CLIPCHILDREN as i32),
                    );
                }

                let res = create_child_window(parent_hwnd, x, y, width, height, &z_order_for_create);
                let _ = tx_hwnd.send(res);
            })
            .map_err(|e| format!("Failed to dispatch to main thread: {:?}", e))?;

        let child_hwnd = rx_hwnd
            .await
            .map_err(|e| format!("Channel receive error: {:?}", e))??;

        state.active_hwnd.store(child_hwnd, Ordering::SeqCst);

        let parent_hwnd = window
            .hwnd()
            .map(|h| h.0 as usize)
            .or_else(|_| find_main_window_hwnd().ok_or(()))
            .unwrap_or(0);

        if parent_hwnd != 0 {
            state.active_main_hwnd.store(parent_hwnd, Ordering::SeqCst);
        }

        let overlay_win_opt = window.app_handle().get_webview_window("player-overlay");
        if let Some(ref ow) = overlay_win_opt {
            let _ = ow.set_decorations(false);
            let _ = ow.set_resizable(false);
            let _ = ow.set_title("");
        }
        let overlay_hwnd = overlay_win_opt
            .and_then(|w| w.hwnd().ok().map(|h| h.0 as usize))
            .unwrap_or(0);

        if overlay_hwnd != 0 {
            state.active_overlay_hwnd.store(overlay_hwnd, Ordering::SeqCst);
            if parent_hwnd != 0 {
                ensure_overlay_ownership(parent_hwnd, overlay_hwnd);
            }
            install_overlay_subclass(overlay_hwnd);
            ensure_overlay_borderless(overlay_hwnd);
            ACTIVE_IS_FULLSCREEN.store(false, Ordering::SeqCst);
            let crop_px = get_overlay_top_crop_px(overlay_hwnd);
            ACTIVE_TOP_CROP_PX.store(crop_px, Ordering::SeqCst);
            apply_overlay_client_region(overlay_hwnd, Some(crop_px));
            let _ = window.app_handle().emit("overlay-top-crop", serde_json::json!({ "crop": OVERLAY_TOP_CROP_LOGICAL_PX }));
            state.sync_overlay_to_video();
        }

        // 3. Locate bundled mpv.exe
        let mpv_path = crate::utils::get_bin("mpv");
        let pipe_name = format!(r"\\.\pipe\lighthouse-mpv-poc-{}", std::process::id());

        // 4. Build MPV arguments with identical stream/header options to external MPV
        let args = build_embedded_mpv_args(child_hwnd, &pipe_name, &stream);

        let mut cmd = tokio::process::Command::new(&mpv_path);
        cmd.args(&args);
        cmd.kill_on_drop(true);

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn mpv.exe at '{}': {:?}", mpv_path, e))?;

        let child_pid = child.id().unwrap_or(0);
        state.active_pid.store(child_pid, Ordering::SeqCst);
        state.active_hwnd.store(child_hwnd, Ordering::SeqCst);

        // 5. Connect to MPV Named Pipe JSON-IPC
        let mut client_opt = None;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if let Ok(client) = ClientOptions::new().open(&pipe_name) {
                client_opt = Some(client);
                break;
            }
        }
        let client = match client_opt {
            Some(c) => c,
            None => {
                {
                    let mut inner = state.inner.lock().await;
                    inner.child_process = Some(child);
                    inner.child_pid = if child_pid != 0 { Some(child_pid) } else { None };
                    inner.child_hwnd = Some(child_hwnd);
                    inner.app_handle = Some(window.app_handle().clone());
                }
                stop_embedded_poc_internal(&state).await;
                return Err("Timed out waiting for MPV Named Pipe server to initialize".to_string());
            }
        };

        let (reader, mut writer) = tokio::io::split(client);
        let (tx, mut rx) = mpsc::channel::<String>(32);

        // Background task: write commands to MPV named pipe
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let mut data = msg.into_bytes();
                if !data.ends_with(b"\n") {
                    data.push(b'\n');
                }
                if writer.write_all(&data).await.is_err() {
                    break;
                }
            }
        });

        // Background task: read IPC events from MPV and forward to Angular
        let app_handle = window.app_handle().clone();
        let tx_events = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            let mut last_dw: Option<f64> = None;
            let mut last_dh: Option<f64> = None;
            let mut last_emitted_aspect: f64 = 0.0;

            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_handle.emit("embedded-poc-event", &line);

                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(event_name) = val.get("event").and_then(|v| v.as_str()) {
                        match event_name {
                            "file-loaded" | "playback-restart" | "tracks-changed" => {
                                let _ = tx_events
                                    .send(r#"{"command": ["get_property", "track-list"], "request_id": 200}"#.to_string())
                                    .await;
                                let _ = tx_events
                                    .send(r#"{"command": ["get_property", "aid"], "request_id": 201}"#.to_string())
                                    .await;
                                let _ = tx_events
                                    .send(r#"{"command": ["get_property", "sid"], "request_id": 202}"#.to_string())
                                    .await;
                            }
                            "property-change" => {
                                if let Some(name) = val.get("name").and_then(|v| v.as_str()) {
                            let mut aspect_opt: Option<f64> = None;

                            match name {
                                "video-params/aspect" => {
                                    if let Some(a) = val.get("data").and_then(|d| d.as_f64()) {
                                        if a > 0.0 && a.is_finite() {
                                            aspect_opt = Some(a);
                                        }
                                    }
                                }
                                "video-params" => {
                                    if let Some(data) = val.get("data") {
                                        if let Some(a) = data.get("aspect").and_then(|d| d.as_f64()) {
                                            if a > 0.0 && a.is_finite() {
                                                aspect_opt = Some(a);
                                            }
                                        } else if let (Some(dw), Some(dh)) = (
                                            data.get("dw").and_then(|d| d.as_f64()),
                                            data.get("dh").and_then(|d| d.as_f64()),
                                        ) {
                                            if dw > 0.0 && dh > 0.0 {
                                                aspect_opt = Some(dw / dh);
                                            }
                                        }
                                    }
                                }
                                "dwidth" => {
                                    if let Some(w) = val.get("data").and_then(|d| d.as_f64()) {
                                        if w > 0.0 && w.is_finite() {
                                            last_dw = Some(w);
                                            if let Some(h) = last_dh {
                                                if h > 0.0 {
                                                    aspect_opt = Some(w / h);
                                                }
                                            }
                                        }
                                    }
                                }
                                "dheight" => {
                                    if let Some(h) = val.get("data").and_then(|d| d.as_f64()) {
                                        if h > 0.0 && h.is_finite() {
                                            last_dh = Some(h);
                                            if let Some(w) = last_dw {
                                                if w > 0.0 {
                                                    aspect_opt = Some(w / h);
                                                }
                                            }
                                        }
                                    }
                                }
                                _ => {}
                            }

                            if let Some(aspect) = aspect_opt {
                                if (aspect - last_emitted_aspect).abs() > 0.005 {
                                    last_emitted_aspect = aspect;
                                    let _ = app_handle.emit("video-aspect-changed", aspect);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let _ = app_handle.emit("embedded-poc-stopped", ());
});

        // Observe playback properties
        let _ = tx
            .send(r#"{"command": ["observe_property", 1, "time-pos"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 2, "pause"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 3, "duration"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 4, "volume"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 5, "mute"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 6, "track-list"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 7, "sid"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 8, "aid"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 9, "sub-scale"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 10, "video-params/aspect"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 11, "video-params"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 12, "dwidth"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 13, "dheight"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 15, "demuxer-cache-duration"]}"#.to_string())
            .await;
        let _ = tx
            .send(r#"{"command": ["observe_property", 16, "demuxer-cache-state"]}"#.to_string())
            .await;

        // 6. Ensure the embedded child window is presented on top and updated now that MPV has connected
        let child_hwnd_val = child_hwnd;
        let app_handle = window.app_handle().clone();
        let _ = window.run_on_main_thread(move || {
            unsafe {
                win32::SetWindowPos(
                    child_hwnd_val as win32::HWND,
                    win32::HWND_TOP,
                    x,
                    y,
                    width,
                    height,
                    win32::SWP_SHOWWINDOW | win32::SWP_NOACTIVATE,
                );
                win32::UpdateWindow(child_hwnd_val as win32::HWND);
            }
            let poc_state = app_handle.state::<EmbeddedPocState>();
            poc_state.sync_overlay_to_video();
        });

        // Store state
        let mut inner = state.inner.lock().await;
        inner.child_hwnd = Some(child_hwnd);
        inner.overlay_hwnd = if overlay_hwnd != 0 { Some(overlay_hwnd) } else { None };
        inner.last_bounds = Some((x, y, width, height));
        inner.windowed_bounds = Some((x, y, width, height));
        inner.child_process = Some(child);
        inner.child_pid = if child_pid != 0 { Some(child_pid) } else { None };
        inner.ipc_tx = Some(tx);
        inner.stream_info = Some(stream.clone());
        inner.app_handle = Some(window.app_handle().clone());

        let _ = window.app_handle().emit("embedded-player-started", &stream);

        Ok(stream)
    }
}

#[tauri::command]
pub async fn start_embedded_player(
    window: WebviewWindow,
    channel: crate::types::Channel,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    z_order: Option<String>,
    state: State<'_, EmbeddedPocState>,
) -> Result<PocStreamInfo, String> {
    let stream = build_stream_info_from_channel(&channel)?;
    if let Some(id) = channel.id {
        let _ = crate::sql::add_last_watched(id);
    }
    start_embedded_player_internal(window, stream, x, y, width, height, z_order, state).await
}

#[tauri::command]
pub async fn switch_embedded_channel(
    channel: crate::types::Channel,
    state: State<'_, EmbeddedPocState>,
    app: AppHandle,
) -> Result<(), String> {
    let stream = build_stream_info_from_channel(&channel)?;
    if let Some(id) = channel.id {
        let _ = crate::sql::add_last_watched(id);
    }
    let inner = state.inner.lock().await;
    if let Some(ref tx) = inner.ipc_tx {
        let mut headers_vec = Vec::new();
        if let Some(ref orig) = stream.origin {
            headers_vec.push(format!("origin:{}", orig));
        }
        if let Some(ref refer) = stream.referrer {
            headers_vec.push(format!("referer:{}", refer));
        }
        if let Some(ref ua) = stream.user_agent {
            let _ = tx
                .send(serde_json::json!({
                    "command": ["set_property", "user-agent", ua]
                }).to_string())
                .await;
        }
        if !headers_vec.is_empty() {
            let _ = tx
                .send(serde_json::json!({
                    "command": ["set_property", "http-header-fields", headers_vec.join(",")]
                }).to_string())
                .await;
        }
        let _ = tx
            .send(serde_json::json!({
                "command": ["loadfile", stream.url, "replace"]
            }).to_string())
            .await;

        let _ = app.emit(
            "embedded-player-started",
            serde_json::json!({
                "name": &stream.name,
                "channel_id": stream.channel_id,
                "url": &stream.url,
                "source_id": stream.source_id,
            }),
        );
        Ok(())
    } else {
        Err("MPV IPC channel is not connected".to_string())
    }
}

#[tauri::command]
pub async fn open_in_external_mpv(
    channel: crate::types::Channel,
    app_state: State<'_, Mutex<crate::types::AppState>>,
    embedded_state: State<'_, EmbeddedPocState>,
) -> Result<(), String> {
    // 1. Terminate any active embedded player session to release child HWND & audio
    stop_embedded_poc_internal(&embedded_state).await;

    // 2. Play via existing, proven external MPV engine (100% untouched)
    crate::mpv::play(channel, false, None, app_state)
        .await
        .map_err(|e| format!("External MPV playback error: {:?}", e))
}

#[tauri::command]
pub async fn resize_embedded_poc(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    state: State<'_, EmbeddedPocState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut inner = state.inner.lock().await;

        let is_fs = if let Some(ref app) = inner.app_handle {
            app.get_webview_window("main").and_then(|w| w.is_fullscreen().ok()).unwrap_or(false)
        } else {
            false
        };

        // In fullscreen mode, ignore Angular measurements so we don't shrink the fullscreen video
        if is_fs {
            return Ok(());
        }

        let bounds = (x, y, width, height);
        if inner.last_bounds == Some(bounds) {
            return Ok(());
        }

        inner.last_bounds = Some(bounds);
        inner.windowed_bounds = Some((x, y, width, height));

        if let Some(child_hwnd) = inner.child_hwnd {
            if let Some(ref app) = inner.app_handle {
                let app_handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    unsafe {
                        win32::SetWindowPos(
                            child_hwnd as win32::HWND,
                            win32::HWND_TOP,
                            x,
                            y,
                            width,
                            height,
                            win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW,
                        );
                        win32::UpdateWindow(child_hwnd as win32::HWND);
                    }
                    let poc_state = app_handle.state::<EmbeddedPocState>();
                    poc_state.sync_overlay_to_video();
                });
            } else {
                unsafe {
                    win32::SetWindowPos(
                        child_hwnd as win32::HWND,
                        win32::HWND_TOP,
                        x,
                        y,
                        width,
                        height,
                        win32::SWP_NOACTIVATE | win32::SWP_SHOWWINDOW,
                    );
                    win32::UpdateWindow(child_hwnd as win32::HWND);
                }
                state.sync_overlay_to_video();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn send_embedded_poc_ipc(
    command: String,
    state: State<'_, EmbeddedPocState>,
) -> Result<(), String> {
    let inner = state.inner.lock().await;
    if let Some(ref tx) = inner.ipc_tx {
        tx.send(command).await.map_err(|e| format!("{:?}", e))?;
        Ok(())
    } else {
        Err("MPV IPC channel is not connected".to_string())
    }
}

#[tauri::command]
pub async fn stop_embedded_poc(
    state: State<'_, EmbeddedPocState>,
) -> Result<(), String> {
    stop_embedded_poc_internal(&state).await;
    Ok(())
}

pub async fn stop_embedded_poc_internal(state: &EmbeddedPocState) {
    state.active_pid.store(0, Ordering::SeqCst);
    state.active_hwnd.store(0, Ordering::SeqCst);

    let overlay_hwnd = state.active_overlay_hwnd.load(Ordering::SeqCst);
    if overlay_hwnd != 0 {
        #[cfg(target_os = "windows")]
        unsafe {
            win32::ShowWindow(overlay_hwnd as win32::HWND, win32::SW_HIDE);
        }
    }

    let (child_opt, child_pid, hwnd_opt, app_opt) = {
        let mut inner = state.inner.lock().await;
        let child = inner.child_process.take();
        let pid = inner.child_pid.take();
        #[cfg(target_os = "windows")]
        let hwnd = inner.child_hwnd.take();
        #[cfg(not(target_os = "windows"))]
        let hwnd: Option<usize> = None;
        let app = inner.app_handle.take();
        inner.ipc_tx = None;
        inner.stream_info = None;
        inner.last_bounds = None;
        inner.windowed_bounds = None;
        #[cfg(target_os = "windows")]
        {
            inner.overlay_hwnd = None;
        }
        (child, pid, hwnd, app)
    };

    if let Some(mut child) = child_opt {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    if let Some(pid) = child_pid {
        terminate_process_by_pid(pid);
    }

    if let Some(hwnd) = hwnd_opt {
        if let Some(ref app) = app_opt {
            let _ = app.run_on_main_thread(move || {
                destroy_child_window(hwnd);
            });
        } else {
            destroy_child_window(hwnd);
        }
    }

    if let Some(ref app) = app_opt {
        if let Some(main_win) = app.get_webview_window("main") {
            if main_win.is_fullscreen().unwrap_or(false) {
                let _ = main_win.set_fullscreen(false);
                let _ = app.emit("player-fullscreen-changed", false);
            }
        }
        if let Some(overlay_win) = app.get_webview_window("player-overlay") {
            let _ = overlay_win.hide();
        }
        #[cfg(target_os = "windows")]
        {
            ACTIVE_IS_FULLSCREEN.store(false, Ordering::SeqCst);
            ACTIVE_TOP_CROP_PX.store(0, Ordering::SeqCst);
        }
        let _ = app.emit("overlay-top-crop", serde_json::json!({ "crop": OVERLAY_TOP_CROP_LOGICAL_PX }));
        let _ = app.emit("embedded-poc-stopped", ());
    }
}

#[tauri::command]
pub async fn get_embedded_player_info(
    state: State<'_, EmbeddedPocState>,
) -> Result<Option<PocStreamInfo>, String> {
    let inner = state.inner.lock().await;
    Ok(inner.stream_info.clone())
}

#[tauri::command]
pub async fn toggle_player_fullscreen(
    app: AppHandle,
) -> Result<bool, String> {
    if let Some(main_win) = app.get_webview_window("main") {
        let current_fs = main_win.is_fullscreen().unwrap_or(false);
        let new_fs = !current_fs;

        // 1. Hide overlay before window transition so no intermediate sizing is visible
        if let Some(state) = app.try_state::<EmbeddedPocState>() {
            state.hide_overlay();
            if new_fs {
                if let Ok(mut inner) = state.inner.try_lock() {
                    if inner.windowed_bounds.is_none() {
                        inner.windowed_bounds = inner.last_bounds;
                    }
                }
            }
        }

        // 2. Change fullscreen state
        main_win.set_fullscreen(new_fs).map_err(|e| format!("Failed to set fullscreen: {:?}", e))?;
        let resulting_fs = main_win.is_fullscreen().unwrap_or(new_fs);

        // 3. Emit event to frontend for UI icons/classes
        let _ = app.emit("player-fullscreen-changed", resulting_fs);

        Ok(resulting_fs)
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub async fn set_main_window_fullscreen(
    fullscreen: bool,
    app: AppHandle,
) -> Result<bool, String> {
    if let Some(main_win) = app.get_webview_window("main") {
        if let Some(state) = app.try_state::<EmbeddedPocState>() {
            state.hide_overlay();
            if fullscreen {
                if let Ok(mut inner) = state.inner.try_lock() {
                    if inner.windowed_bounds.is_none() {
                        inner.windowed_bounds = inner.last_bounds;
                    }
                }
            }
        }
        main_win.set_fullscreen(fullscreen).map_err(|e| format!("Failed to set fullscreen: {:?}", e))?;
        let resulting = main_win.is_fullscreen().unwrap_or(fullscreen);
        let _ = app.emit("player-fullscreen-changed", resulting);
        Ok(resulting)
    } else {
        Err("Main window not found".to_string())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SavedSubtitleRecord {
    pub id: String,
    pub media_key: String,
    pub channel_id: Option<i64>,
    pub file_name: String,
    pub managed_path: String,
    pub added_at: i64,
}

fn get_subtitles_dir() -> Result<std::path::PathBuf, String> {
    let proj = directories::ProjectDirs::from("dev", "fredol", "open-tv")
        .ok_or_else(|| "Failed to get project dirs".to_string())?;
    let dir = proj.data_dir().join("subtitles");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create subtitles directory: {}", e))?;
    }
    Ok(dir)
}

fn get_subtitles_manifest_path() -> Result<std::path::PathBuf, String> {
    let dir = get_subtitles_dir()?;
    Ok(dir.join("subtitles.json"))
}

fn load_subtitles_manifest() -> Vec<SavedSubtitleRecord> {
    if let Ok(path) = get_subtitles_manifest_path() {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(records) = serde_json::from_str::<Vec<SavedSubtitleRecord>>(&content) {
                    return records;
                }
            }
        }
    }
    Vec::new()
}

fn save_subtitles_manifest(records: &[SavedSubtitleRecord]) -> Result<(), String> {
    let path = get_subtitles_manifest_path()?;
    let json = serde_json::to_string_pretty(records)
        .map_err(|e| format!("Serialization error: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write subtitles manifest: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn save_external_subtitle(
    source_path: String,
    file_name: String,
    media_key: String,
    channel_id: Option<i64>,
) -> Result<SavedSubtitleRecord, String> {
    let src = std::path::Path::new(&source_path);
    if !src.exists() || !src.is_file() {
        return Err("Source subtitle file does not exist".to_string());
    }

    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["srt", "ass", "ssa", "vtt"].contains(&ext.as_str()) {
        return Err(format!("Unsupported subtitle format: .{}", ext));
    }

    let dir = get_subtitles_dir()?;
    let clean_name: String = file_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let sub_id = format!("{}_{}", chrono::Utc::now().timestamp_millis(), clean_name);
    let dest_path = dir.join(&sub_id);

    std::fs::copy(src, &dest_path)
        .map_err(|e| format!("Failed to copy subtitle file to app-data directory: {}", e))?;

    let mut records = load_subtitles_manifest();

    // Avoid duplicate entries: if the same media has a subtitle with the same file name, replace it
    records.retain(|r| {
        let same_media = (!media_key.is_empty() && r.media_key == media_key)
            || (channel_id.is_some() && r.channel_id.is_some() && r.channel_id == channel_id);
        let same_name = r.file_name.eq_ignore_ascii_case(&file_name);
        if same_media && same_name {
            let old_file = std::path::PathBuf::from(&r.managed_path);
            if old_file.starts_with(&dir) && old_file.exists() {
                let _ = std::fs::remove_file(&old_file);
            }
            return false;
        }
        true
    });

    let record = SavedSubtitleRecord {
        id: sub_id,
        media_key,
        channel_id,
        file_name,
        managed_path: dest_path.to_string_lossy().to_string(),
        added_at: chrono::Utc::now().timestamp_millis(),
    };

    records.push(record.clone());
    save_subtitles_manifest(&records)?;

    Ok(record)
}

#[tauri::command]
pub async fn get_saved_external_subtitles(
    media_key: String,
    channel_id: Option<i64>,
) -> Result<Vec<SavedSubtitleRecord>, String> {
    let records = load_subtitles_manifest();
    let mut matched = Vec::new();
    for rec in records {
        let key_match = !media_key.is_empty() && rec.media_key == media_key;
        let ch_match = channel_id.is_some() && rec.channel_id.is_some() && rec.channel_id == channel_id;
        if key_match || ch_match {
            // Gracefully ignore missing subtitle files
            if std::path::Path::new(&rec.managed_path).exists() {
                matched.push(rec);
            }
        }
    }
    Ok(matched)
}

#[tauri::command]
pub async fn remove_external_subtitle(
    id: String,
    managed_path: String,
) -> Result<(), String> {
    if let Ok(dir) = get_subtitles_dir() {
        let p = std::path::PathBuf::from(&managed_path);
        // Never delete the user's original file: only delete files inside Lighthouse's managed subtitles directory!
        if p.starts_with(&dir) && p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }

    let mut records = load_subtitles_manifest();
    records.retain(|r| {
        if !id.is_empty() && r.id == id {
            return false;
        }
        if !managed_path.is_empty() && r.managed_path == managed_path {
            return false;
        }
        true
    });
    save_subtitles_manifest(&records)?;

    Ok(())
}

#[tauri::command]
pub async fn fetch_playback_segments(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Lighthouse")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(text)
}
