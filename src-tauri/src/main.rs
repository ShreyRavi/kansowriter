// Kansowriter for macOS: the web app's frontend in a WKWebView, plus the few things a browser
// would otherwise do for it (save downloads, open outside links, flush unsaved words on quit).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewWindowBuilder, WindowEvent};

#[cfg(debug_assertions)]
mod probe;
mod terminate;

/// The page has this long to save before the app quits anyway (the page itself gives up at 2 s).
const QUIT_TIMEOUT: Duration = Duration::from_secs(3);

/// The page has answered (or the wait is over): the next terminate request really quits.
static EXITING: AtomicBool = AtomicBool::new(false);
/// A quit (⌘Q, ⌘W, the close button) is in progress: waiting for the page to save.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// The page could not save everything once; the next quit goes through regardless.
static FORCE: AtomicBool = AtomicBool::new(false);
/// Bumped per quit attempt, so a stale timeout never ends a later attempt.
static ATTEMPT: AtomicU64 = AtomicU64::new(0);

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
/// browser would (WebKit picks the name and adds " (1)" when it exists). Nothing else downloads.
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

fn exit_now(app: &AppHandle) {
    trace!("exit");
    EXITING.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Ask the page to save every open draft, then quit (it answers through `quit_ready`).
fn request_quit(app: &AppHandle) {
    trace!("requested (force: {})", FORCE.load(Ordering::SeqCst));
    let Some(window) = app.get_webview_window("main") else {
        return exit_now(app);
    };
    if FORCE.load(Ordering::SeqCst) {
        // second try after a failed save: one more save attempt, then quit whatever happens
        let _ = window.eval("window.__kansoBeforeQuit?.()");
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(QUIT_TIMEOUT);
            exit_now(&app);
        });
        return;
    }
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let attempt = ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;
    // a page without the hook (still loading, or crashed) has nothing of ours to save
    if window
        .eval("window.__kansoBeforeQuit ? window.__kansoBeforeQuit() : window.__TAURI_INTERNALS__.invoke('quit_ready', { saved: true })")
        .is_err()
    {
        return exit_now(app);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_TIMEOUT);
        if QUITTING.load(Ordering::SeqCst) && ATTEMPT.load(Ordering::SeqCst) == attempt {
            exit_now(&app);
        }
    });
}

/// The page saved (or tried to). If something is still unsaved it stays open, showing its own
/// notice, and the next quit goes through regardless.
#[tauri::command]
fn quit_ready(app: AppHandle, saved: bool) {
    trace!("page answered, saved: {saved}");
    if saved || FORCE.load(Ordering::SeqCst) {
        exit_now(&app);
    } else {
        FORCE.store(true, Ordering::SeqCst);
        QUITTING.store(false, Ordering::SeqCst);
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
                    request_quit(window.app_handle());
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
