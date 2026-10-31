//! Every way of quitting asks the page to save first. ⌘Q (the default menu's Quit), Quit in the
//! Dock, an Apple Event quit and logout/restart/shutdown all reach `applicationShouldTerminate:`
//! on the app delegate, which tao doesn't implement, so the app quit at once and a closing
//! WKWebView fires no pagehide: the last second of typing could be lost. This adds the method to
//! tao's delegate class. It answers NSTerminateLater, runs `request_quit` (the page saves, then
//! answers `quit_ready`) and replies YES once saved or after quit::QUIT_TIMEOUT, so a logout or
//! an update's restart is only delayed, never cancelled. It replies NO in one case: the save
//! failed, nothing was forced, and the app stays open on its notice (quit::Outcome::Stay).
//! AppKit runs the main run loop in a modal mode meanwhile; tao's sources are registered for the
//! common modes, so IPC, timers and run_on_main_thread keep working.
use std::sync::atomic::Ordering;
use std::sync::OnceLock;

use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::NSApplication;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// NSApplicationTerminateReply
const TERMINATE_NOW: usize = 1;
const TERMINATE_LATER: usize = 2;

extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
    let exiting = super::EXITING.load(Ordering::SeqCst);
    super::trace!("applicationShouldTerminate (exiting: {exiting})");
    match APP.get() {
        Some(app) if !exiting => {
            // the reply always goes through run_on_main_thread, so it lands after this returns
            super::request_quit(app, super::quit::Via::Terminate);
            TERMINATE_LATER
        }
        _ => TERMINATE_NOW,
    }
}

/// Answer a pending NSTerminateLater (on the main thread, after should_terminate has returned).
pub fn reply(app: &AppHandle, quit: bool) {
    super::trace!("replyToApplicationShouldTerminate: {quit}");
    let _ = app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            super::trace!("replying on the main thread");
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(quit);
            super::trace!("replied");
        }
    });
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
    let added = unsafe {
        let imp: Imp = std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize, Imp>(
            should_terminate,
        );
        objc2::ffi::class_addMethod(
            class as *const _ as *mut _,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        )
    };
    // false means tao now implements it itself: this hook would be silently skipped
    debug_assert!(
        added.as_bool(),
        "applicationShouldTerminate: already exists on tao's app delegate"
    );
}
