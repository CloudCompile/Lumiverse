use std::sync::{atomic::AtomicBool, Arc};
use tauri::AppHandle;
use tokio::sync::oneshot;

#[cfg(not(target_os = "windows"))]
use super::Capabilities;
use super::{CaptureRequest, Media};

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{
        ffi::{c_char, c_void, CString},
        slice,
        sync::atomic::Ordering,
    };

    type Sender = oneshot::Sender<Result<Media, &'static str>>;

    struct Completion {
        sender: Sender,
        active: Arc<AtomicBool>,
    }

    extern "C" {
        fn lumiverse_capture_capabilities() -> u32;
        fn lumiverse_capture_begin(
            request_id: *const c_char,
            consent: *const c_char,
            summary: *const c_char,
            video: bool,
            seconds: u64,
            max_bytes: usize,
            max_pixels: u64,
            remaining_ms: u64,
            callback: extern "C" fn(*mut c_void, u32, *const u8, usize, u32, u32, f64),
            context: *mut c_void,
        );
        fn lumiverse_capture_cancel(request_id: *const c_char);
        fn lumiverse_capture_shutdown();
    }

    pub fn capabilities() -> Capabilities {
        let flags = unsafe { lumiverse_capture_capabilities() };
        Capabilities {
            image: flags & 1 != 0,
            video: flags & 2 != 0,
            replay: false,
        }
    }

    extern "C" fn complete(
        context: *mut c_void,
        outcome: u32,
        bytes: *const u8,
        count: usize,
        width: u32,
        height: u32,
        duration: f64,
    ) {
        let completion = unsafe { Box::from_raw(context as *mut Completion) };
        let result = match outcome {
            0 if completion.active.load(Ordering::SeqCst)
                && !bytes.is_null()
                && count > 0
                && count <= super::super::VIDEO_BYTES =>
            {
                Ok(Media {
                    bytes: unsafe { slice::from_raw_parts(bytes, count) }.to_vec(),
                    width,
                    height,
                    duration_seconds: if duration > 0.0 { Some(duration) } else { None },
                })
            }
            1 => Err("denied"),
            2 => Err("cancelled"),
            3 => Err("unsupported"),
            _ => Err("failed"),
        };
        let _ = completion.sender.send(result);
    }

    pub fn begin(
        app: &AppHandle,
        request: &CaptureRequest,
        origin: &str,
        account: &str,
        active: Arc<AtomicBool>,
    ) -> oneshot::Receiver<Result<Media, &'static str>> {
        let (sender, receiver) = oneshot::channel();
        let request = request.clone();
        let consent = request.consent_text(origin, account);
        let summary = request.consent_summary(origin, account);
        let context = Box::into_raw(Box::new(Completion {
            sender,
            active: active.clone(),
        })) as usize;
        if app
            .run_on_main_thread(move || {
                if !active.load(Ordering::SeqCst) || request.expires_at <= super::super::now_ms() {
                    let completion = unsafe { Box::from_raw(context as *mut Completion) };
                    let _ = completion.sender.send(Err("cancelled"));
                    return;
                }
                let request_id = CString::new(request.request_id).unwrap();
                let consent = CString::new(consent).unwrap();
                let summary = CString::new(summary).unwrap();
                unsafe {
                    lumiverse_capture_begin(
                        request_id.as_ptr(),
                        consent.as_ptr(),
                        summary.as_ptr(),
                        request.kind == "video",
                        request.duration_seconds.unwrap_or_default(),
                        request.max_bytes,
                        request.max_pixels,
                        request.expires_at.saturating_sub(super::super::now_ms()),
                        complete,
                        context as *mut c_void,
                    );
                }
            })
            .is_err()
        {
            let completion = unsafe { Box::from_raw(context as *mut Completion) };
            let _ = completion.sender.send(Err("failed"));
        }
        receiver
    }

    pub fn cancel(app: &AppHandle, request_id: &str) {
        if let Ok(request_id) = CString::new(request_id) {
            let _ = app.run_on_main_thread(move || unsafe {
                lumiverse_capture_cancel(request_id.as_ptr())
            });
        }
    }

    pub fn shutdown() {
        unsafe { lumiverse_capture_shutdown() };
    }
}

#[cfg(target_os = "macos")]
pub use macos::{begin, cancel, capabilities, shutdown};

#[cfg(target_os = "windows")]
pub use super::windows::{capabilities, shutdown};

#[cfg(target_os = "windows")]
pub fn begin(
    _: &AppHandle,
    request: &CaptureRequest,
    origin: &str,
    account: &str,
    active: Arc<AtomicBool>,
) -> oneshot::Receiver<Result<Media, &'static str>> {
    super::windows::begin(
        request,
        request.consent_text(origin, account),
        request.consent_summary(origin, account),
        active,
    )
}

#[cfg(target_os = "windows")]
pub fn cancel(_: &AppHandle, request_id: &str) {
    super::windows::cancel(request_id);
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn capabilities() -> Capabilities {
    Capabilities {
        image: false,
        video: false,
        replay: false,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn begin(
    _: &AppHandle,
    _: &CaptureRequest,
    _: &str,
    _: &str,
    _: Arc<AtomicBool>,
) -> oneshot::Receiver<Result<Media, &'static str>> {
    let (sender, receiver) = oneshot::channel();
    let _ = sender.send(Err("unsupported"));
    receiver
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn cancel(_: &AppHandle, _: &str) {}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn shutdown() {}
