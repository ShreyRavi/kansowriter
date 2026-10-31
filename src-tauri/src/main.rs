// Kansowriter for macOS: the web app's frontend in a WKWebView, plus the few things a browser
// would otherwise do for it (save downloads, open outside links, flush unsaved words on quit).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewWindowBuilder, WindowEvent};

#[cfg(debug_assertions)]
mod probe;
mod quit;
mod terminate;

/// The page has answered (or the wait is over) and the app is quitting: terminate requests pass.
static EXITING: AtomicBool = AtomicBool::new(false);
static QUIT: Mutex<quit::State> = Mutex::new(quit::State::new());

/// Where the window may navigate: only the app itself. Everything else is refused.
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "about" => true,
        // `npm run desktop:dev` loads the Vite dev server
        "http" if cfg!(debug_assertions) => url.host_str() == Some("localhost") && url.port() == Some(5173),
        _ => false,
    }
}

/// Links the user may open in their browser: web pages and mail, never files or custom schemes.
fn is_external_link(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "mailto") && !is_app_url(url)
}

fn open_externally(url: &Url) {
    if is_external_link(url) {
        #[cfg(debug_assertions)]
        if probe::log_open(url) {
            return;
        }
        // `open` hands the URL to the default browser; the URL is one argument, never a shell string
        let _ = std::process::Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    }
}

/// Exports and backups are blob downloads made by the page: save them to ~/Downloads, as a
/// browser would (WebKit suggests the name; wry adds " (1)" when it exists). Nothing else downloads.
fn allow_download(url: &Url) -> bool {
    url.scheme() == "blob"
}

/// Debug builds narrate the quit path on stderr.
macro_rules! trace {
    ($($t:tt)*) => {
        #[cfg(debug_assertions)]
        eprintln!("[quit] {}", format!($($t)*));
    };
}
pub(crate) use trace;

fn quit_state() -> std::sync::MutexGuard<'static, quit::State> {
    QUIT.lock().unwrap_or_else(|e| e.into_inner())
}

/// Act on a decision: quit (answering AppKit, or exiting ourselves after ⌘W), or stay open.
fn finish(app: &AppHandle, outcome: quit::Outcome) {
    trace!("{outcome:?}");
    match outcome {
        quit::Outcome::Proceed { terminate } => {
            EXITING.store(true, Ordering::SeqCst);
            if terminate {
                terminate::reply(app, true);
            } else {
                app.exit(0);
            }
        }
        quit::Outcome::Stay { terminate } => {
            if terminate {
                terminate::reply(app, false);
            }
        }
    }
}

/// Ask the page to save every open draft (it answers through `quit_ready`), with a time cap.
fn request_quit(app: &AppHandle, via: quit::Via) {
    let Some(attempt) = quit_state().begin(via, Instant::now()) else {
        trace!("{via:?} joins the quit in progress");
        return;
    };
    trace!("{via:?}: attempt {attempt}");
    // a page without the hook (still loading, or crashed) has nothing of ours to save
    let asked = app.get_webview_window("main").is_some_and(|w| {
        w.eval("window.__kansoBeforeQuit ? window.__kansoBeforeQuit() : window.__TAURI_INTERNALS__.invoke('quit_ready', { saved: true })")
            .is_ok()
    });
    if !asked {
        let outcome = quit_state().timeout(attempt);
        if let Some(outcome) = outcome {
            finish(app, outcome);
        }
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(quit::QUIT_TIMEOUT);
        let outcome = quit_state().timeout(attempt);
        if let Some(outcome) = outcome {
            trace!("no answer within {:?}", quit::QUIT_TIMEOUT);
            finish(&app, outcome);
        }
    });
}

/// The page saved (or tried to). With words still unsaved the app stays open once, showing a
/// notice; a quit within quit::FORCE_WINDOW then goes through.
#[tauri::command]
fn quit_ready(app: AppHandle, saved: bool) {
    trace!("page answered, saved: {saved}");
    let outcome = quit_state().answer(saved, Instant::now());
    if let Some(outcome) = outcome {
        finish(&app, outcome);
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![quit_ready])
        .setup(|app| {
            // ⌘Q, Quit in the Dock, an Apple Event quit and logout all go through request_quit
            terminate::install(app.handle().clone());
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("tauri.conf.json defines the main window");
            let builder = WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_navigation(|url| {
                    if is_app_url(url) {
                        return true;
                    }
                    open_externally(url);
                    false
                })
                .on_new_window(|url, _| {
                    open_externally(&url);
                    NewWindowResponse::Deny
                })
                .on_download(|_, event| match event {
                    DownloadEvent::Requested { url, destination } => {
                        #[cfg(debug_assertions)]
                        probe::redirect_download(destination);
                        let _ = &destination;
                        allow_download(&url)
                    }
                    _ => true,
                });
            #[cfg(debug_assertions)]
            let builder = probe::attach(builder);
            builder.build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    request_quit(window.app_handle(), quit::Via::Close);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Kansowriter");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_window_stays_on_the_app() {
        assert!(is_app_url(&u("tauri://localhost/")));
        assert!(is_app_url(&u("tauri://localhost/about")));
        assert!(is_app_url(&u("tauri://localhost/l#v1.abc")));
        assert!(is_app_url(&u("about:blank")));
        assert!(!is_app_url(&u("tauri://evil.example/")));
        assert!(!is_app_url(&u("https://writer.kansoboard.com/")));
        assert!(!is_app_url(&u("file:///etc/passwd")));
        assert!(!is_app_url(&u("http://localhost:8080/")));
    }

    #[test]
    fn only_web_and_mail_links_open_outside() {
        assert!(is_external_link(&u("https://writer.kansoboard.com/l#v1.abc")));
        assert!(is_external_link(&u("http://example.com/")));
        assert!(is_external_link(&u("mailto:someone@example.com")));
        assert!(!is_external_link(&u("file:///Applications/Calculator.app")));
        assert!(!is_external_link(&u("tauri://localhost/")));
        assert!(!is_external_link(&u("x-apple.systempreferences:com.apple.preference")));
        assert!(!is_external_link(&u("javascript:alert(1)")));
    }

    #[test]
    fn only_page_blobs_download() {
        assert!(allow_download(&u(
            "blob:tauri://localhost/2b6c4d4e-0000-4000-8000-000000000000"
        )));
        assert!(!allow_download(&u("https://example.com/file.zip")));
        assert!(!allow_download(&u("data:text/plain,hi")));
    }
}
