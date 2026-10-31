//! Every way of quitting asks the page to save first. ⌘Q (the default menu's Quit), Quit in the
//! Dock, an Apple Event quit and logout all reach `applicationShouldTerminate:` on the app
//! delegate, which tao doesn't implement, so the app quit at once and a closing WKWebView fires
//! no pagehide: the last second of typing could be lost. This adds the method to tao's delegate
//! class: it cancels the first request, runs `request_quit` (the page saves, then answers
//! `quit_ready`), and the app then exits on its own.
use std::sync::atomic::Ordering;
use std::sync::OnceLock;

use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::NSApplication;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// NSApplicationTerminateReply
const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;

extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
    super::trace!(
        "applicationShouldTerminate (exiting: {})",
        super::EXITING.load(Ordering::SeqCst)
    );
    match APP.get() {
        Some(app) if !super::EXITING.load(Ordering::SeqCst) => {
            super::request_quit(app);
            TERMINATE_CANCEL
        }
        _ => TERMINATE_NOW,
    }
}

pub fn install(app: AppHandle) {
    let _ = APP.set(app);
    let Some(mtm) = MainThreadMarker::new() else { return };
    let ns_app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = ns_app.delegate() else { return };
    let object: &AnyObject = delegate.as_ref();
    let class = object.class();
    // SAFETY: the function matches `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender`
    // ("Q@:@": NSUInteger return, self, _cmd, one object), and class_addMethod leaves an existing method alone.
    unsafe {
        let imp: Imp = std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize, Imp>(
            should_terminate,
        );
        objc2::ffi::class_addMethod(
            class as *const _ as *mut _,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        );
    }
}
