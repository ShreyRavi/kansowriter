//! Debug builds only: drive the app's webview from the outside, since Playwright can't drive
//! WKWebView. With KANSO_PROBE=<script.js>, the script runs after each page load and talks to
//! this loop through `window.__kansoProbe`:
//!   { log: any }                       appended (as a JSON line) to KANSO_PROBE_OUT
//!   { do: [{ click: [x, y] } | { key: "k", cmd?: true, shift?: true, code?: n } | { text: "..." }] }
//!                                      real NSEvents sent through NSApp (trusted input: menus,
//!                                      key equivalents and user activation behave as for a person)
//!   { do: [{ performClose: true }] }  [window performClose:], what ⌘W / the close button send
//!   { terminate: true }                [NSApp terminate:], the path ⌘Q takes (polling goes on)
//!   { menu: "open" | "save-file" | "save-kanso" }  a File menu item, as if clicked
//!   { fullscreen: bool }               enter / leave full screen
//!   { info: true }                     log { window: <windowNumber> } (for `screencapture -l`)
//!   { done: true }                     stop polling
//! After each message the loop clears `__kansoProbe` and calls `__kansoProbeAck()`.
//! KANSO_DOWNLOAD_DIR moves downloads out of ~/Downloads; KANSO_PROBE_SAVE_DIR answers save panels
//! with <dir>/<suggested name> and KANSO_PROBE_OPEN_PATH answers File > Open… (main.rs);
//! KANSO_LS_DRY_RUN / KANSO_LS_TYPES keep "make default" off the person's real defaults
//! (default_app.rs, main.rs). None of this exists in release builds.
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
use objc2_foundation::{NSPoint, NSProcessInfo, NSString};
use serde_json::Value;
use tauri::{Manager, WebviewWindow, Wry};

pub fn redirect_download(destination: &mut PathBuf) {
    if let (Ok(dir), Some(name)) = (std::env::var("KANSO_DOWNLOAD_DIR"), destination.file_name()) {
        *destination = PathBuf::from(dir).join(name);
    }
}

/// With KANSO_OPEN_LOG set, outside links are written there instead of opening the browser.
pub fn log_open(url: &tauri::Url) -> bool {
    let Ok(path) = std::env::var("KANSO_OPEN_LOG") else {
        return false;
    };
    append(&path, url.as_str());
    true
}

fn append(out: &str, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(out) {
        let _ = writeln!(f, "{line}");
    }
    eprintln!("[probe] {line}");
}

/// Ask the page for its pending message.
fn poll(window: &WebviewWindow<Wry>) -> Option<Value> {
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .eval_with_callback("JSON.stringify(window.__kansoProbe ?? null)", move |r| {
            let _ = tx.send(r);
        })
        .ok()?;
    let raw = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    // the callback gets the JSON of the expression's value, here a string of JSON
    let json: String = serde_json::from_str(&raw).unwrap_or(raw);
    serde_json::from_str::<Value>(&json).ok().filter(|v| !v.is_null())
}

fn flag(action: &Value, name: &str) -> bool {
    action.get(name).and_then(Value::as_bool).unwrap_or(false)
}

/// Send real input events to the window, on the main thread.
fn perform(window: &WebviewWindow<Wry>, actions: Vec<Value>) {
    let Ok(ns_window) = window.ns_window() else { return };
    let ns_window = ns_window as usize;
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = window.run_on_main_thread(move || {
        let mtm = MainThreadMarker::new().expect("main thread");
        let app = NSApplication::sharedApplication(mtm);
        // SAFETY: tauri hands out this webview window's live NSWindow
        let ns_window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        let number = ns_window.windowNumber();
        let height = ns_window.contentLayoutRect().size.height;
        // AppKit and WebKit drop events stamped long before now
        let now = || NSProcessInfo::processInfo().systemUptime();
        for action in actions {
            // what ⌘W and the close button do: File > Close Window sends performClose:
            if flag(&action, "performClose") {
                ns_window.performClose(None);
            }
            if let Some(c) = action.get("click").and_then(Value::as_array) {
                let x = c.first().and_then(Value::as_f64).unwrap_or(0.0);
                let y = c.get(1).and_then(Value::as_f64).unwrap_or(0.0);
                for kind in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp] {
                    let e = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                        kind, NSPoint::new(x, height - y), NSEventModifierFlags::empty(), now(), number, None, 0, 1, 1.0,
                    );
                    if let Some(e) = e {
                        app.sendEvent(&e);
                    }
                }
            }
            let mut keys: Vec<(String, NSEventModifierFlags, u16)> = Vec::new();
            if let Some(k) = action.get("key").and_then(Value::as_str) {
                let mut flags = NSEventModifierFlags::empty();
                if flag(&action, "cmd") {
                    flags |= NSEventModifierFlags::Command;
                }
                if flag(&action, "shift") {
                    flags |= NSEventModifierFlags::Shift;
                }
                let code = action.get("code").and_then(Value::as_u64).unwrap_or(0) as u16;
                keys.push((k.to_string(), flags, code));
            }
            if let Some(t) = action.get("text").and_then(Value::as_str) {
                keys.extend(t.chars().map(|c| (c.to_string(), NSEventModifierFlags::empty(), 0)));
            }
            // keys go to the key window: the app's, or an open panel (file picker) in front of it
            let key_window = app.keyWindow().map(|w| w.windowNumber()).unwrap_or(number);
            for (k, flags, code) in keys {
                let s = NSString::from_str(&k);
                for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
                    let e = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                        kind, NSPoint::new(0.0, 0.0), flags, now(), key_window, None, &s, &s, false, code,
                    );
                    if let Some(e) = e {
                        app.sendEvent(&e);
                    }
                }
            }
        }
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(Duration::from_secs(10));
}

/// After each page load (main.rs calls this): run the KANSO_PROBE script and answer its messages.
pub fn page_loaded(window: WebviewWindow<Wry>) {
    let Ok(script_path) = std::env::var("KANSO_PROBE") else {
        return;
    };
    let script = std::fs::read_to_string(&script_path).expect("KANSO_PROBE script");
    let out = std::env::var("KANSO_PROBE_OUT").unwrap_or_else(|_| format!("{script_path}.out.jsonl"));
    {
        // in front, so WebKit renders and runs it unthrottled, as for someone using it
        let _ = window.set_focus();
        let _ = window.eval(script.clone());
        let out = out.clone();
        std::thread::spawn(move || {
            for _ in 0..2400 {
                std::thread::sleep(Duration::from_millis(100));
                let Some(msg) = poll(&window) else { continue };
                if let Some(log) = msg.get("log") {
                    append(&out, &log.to_string());
                }
                if let Some(actions) = msg.get("do").and_then(Value::as_array) {
                    perform(&window, actions.clone());
                }
                let _ = window.eval("window.__kansoProbe = null; window.__kansoProbeAck?.()");
                if flag(&msg, "terminate") {
                    append(&out, "\"terminate\"");
                    let _ = window.run_on_main_thread(|| {
                        let mtm = MainThreadMarker::new().expect("main thread");
                        let app = NSApplication::sharedApplication(mtm);
                        // queued to the run loop, as a menu click is: terminate: must not run inside
                        // tao's event callback (its NSTerminateLater wait would end in tao's exit
                        // handler while the callback still holds tao's lock)
                        // SAFETY: performSelectorOnMainThread:withObject:waitUntilDone: with terminate: and nil
                        unsafe {
                            let _: () = objc2::msg_send![
                                &*app,
                                performSelectorOnMainThread: objc2::sel!(terminate:),
                                withObject: std::ptr::null::<objc2::runtime::AnyObject>(),
                                waitUntilDone: false
                            ];
                        }
                    });
                    // keep listening: a quit the app refuses (unsaved words) leaves the page running
                }
                if let Some(id) = msg.get("menu").and_then(Value::as_str) {
                    // a File menu item, as if clicked
                    let (app, id) = (window.app_handle().clone(), id.to_string());
                    let _ = window.run_on_main_thread(move || crate::on_menu(&app, &id));
                }
                if let Some(on) = msg.get("fullscreen").and_then(Value::as_bool) {
                    let _ = window.set_fullscreen(on);
                }
                if flag(&msg, "info") {
                    let number = window.ns_window().map(|w| {
                        // SAFETY: tauri hands out this webview window's live NSWindow
                        unsafe { &*(w as *const NSWindow) }.windowNumber()
                    });
                    append(&out, &serde_json::json!({ "window": number.unwrap_or(0) }).to_string());
                }
                if flag(&msg, "done") {
                    return;
                }
            }
        });
    }
}
