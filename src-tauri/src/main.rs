// Kansowriter for macOS: the web app's frontend in a WKWebView, plus the few things a browser
// would otherwise do for it (save downloads, open outside links, flush unsaved words on quit),
// and what a Mac app does with files: open .md / .kanso files handed to it and keep a linked
// Markdown file in step with its draft (only files the person granted: files.rs).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[cfg(test)]
mod build_info;
mod default_app;
mod files;
mod menu;
#[cfg(debug_assertions)]
mod probe;
mod quit;
mod terminate;

/// The page has answered (or the wait is over) and the app is quitting: terminate requests pass.
static EXITING: AtomicBool = AtomicBool::new(false);
static QUIT: Mutex<quit::State> = Mutex::new(quit::State::new());
/// Files handed to the app (Finder, Dock, `open -a`, File > Open…) that the page hasn't taken yet:
/// at launch they arrive before the page exists, so they wait here.
static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Paths the page may read and write; loaded from the app data dir on first use.
static GRANTS: Mutex<Option<files::Grants>> = Mutex::new(None);
static FULLSCREEN: AtomicBool = AtomicBool::new(false);

fn lock<T>(m: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn with_grants<R>(app: &AppHandle, f: impl FnOnce(&mut files::Grants) -> R) -> R {
    let mut g = lock(&GRANTS);
    let grants = g.get_or_insert_with(|| match app.path().app_data_dir() {
        Ok(dir) => files::Grants::load(dir.join("granted-files.json")),
        Err(_) => files::Grants::default(),
    });
    f(grants)
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Allow these paths and hand them to the page (now, or when it asks at start-up).
fn grant_and_open(app: &AppHandle, paths: Vec<PathBuf>) {
    let granted: Vec<String> = with_grants(app, |g| {
        paths
            .iter()
            .filter_map(|p| g.grant(p).ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    });
    if granted.is_empty() {
        return;
    }
    lock(&OPENED).extend(granted);
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.eval("window.__kansoOpened?.()");
    }
}

/// File > Open…: a sheet on the window; what is picked is granted and opened.
fn open_dialog(app: &AppHandle) {
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("KANSO_PROBE_OPEN_PATH") {
        grant_and_open(app, vec![PathBuf::from(p)]);
        return;
    }
    let Some(window) = main_window(app) else { return };
    let dialog = rfd::AsyncFileDialog::new()
        .add_filter("Markdown or Kansowriter draft", files::EXTENSIONS)
        .set_parent(&window);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(picked) = dialog.pick_files().await {
            grant_and_open(&app, picked.iter().map(|f| f.path().to_path_buf()).collect());
        }
    });
}

/// A menu item: Open is native; the saves need the open draft, so the page runs them.
pub(crate) fn on_menu(app: &AppHandle, id: &str) {
    match id {
        menu::OPEN => open_dialog(app),
        menu::SAVE_TO_FILE | menu::SAVE_KANSO => {
            if let Some(w) = main_window(app) {
                let _ = w.eval(format!("window.__kansoMenu?.({})", serde_json::json!(id)));
            }
        }
        _ => {}
    }
}

/// Tell the page whether the window is full screen (the traffic lights hide there, and so does
/// the header's room for them).
fn sync_fullscreen(window: &WebviewWindow, force: bool) {
    let on = window.is_fullscreen().unwrap_or(false);
    if FULLSCREEN.swap(on, Ordering::SeqCst) != on || force {
        let _ = window.eval(format!(
            "document.documentElement.toggleAttribute('data-fullscreen', {on})"
        ));
    }
}

fn checked(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    with_grants(app, |g| g.check(path)).map_err(|e| e.to_string())
}

/// Files handed to the app since the page last asked.
#[tauri::command]
fn take_opened() -> Vec<String> {
    std::mem::take(&mut *lock(&OPENED))
}

#[tauri::command]
async fn file_read(app: AppHandle, path: String) -> Result<Response, String> {
    let p = checked(&app, &path)?;
    files::read(&p).map(Response::new).map_err(|e| e.to_string())
}

/// Size and modification time, or null when the file is gone.
#[tauri::command]
async fn file_stat(app: AppHandle, path: String) -> Result<Option<files::Stat>, String> {
    let p = checked(&app, &path)?;
    files::stat(&p).map_err(|e| e.to_string())
}

/// The bytes come as the raw body; the path (percent-encoded) in the `x-kanso-path` header.
#[tauri::command]
async fn file_write(app: AppHandle, request: Request<'_>) -> Result<files::Stat, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("bad-body".into());
    };
    let path = request
        .headers()
        .get("x-kanso-path")
        .and_then(|v| v.to_str().ok())
        .and_then(files::percent_decode)
        .ok_or("bad-path")?;
    let p = checked(&app, &path)?;
    files::write_atomic(&p, bytes).map_err(|e| e.to_string())
}

/// A save panel (a sheet on the window) for a Markdown file or a .kanso; the chosen path is
/// granted. None when cancelled.
#[tauri::command]
async fn pick_save_path(app: AppHandle, kind: String, name: String) -> Result<Option<String>, String> {
    let (label, ext): (&str, &[&str]) = match kind.as_str() {
        "md" => ("Markdown document", &["md", "markdown"]),
        "kanso" => ("Kansowriter draft", &["kanso"]),
        _ => return Err("bad-kind".into()),
    };
    let base: String = name.chars().filter(|c| !matches!(c, '/' | ':' | '\0')).collect();
    let base = base.trim().trim_start_matches('.');
    let base = if base.is_empty() { "Untitled" } else { base };
    let suggested = format!("{base}.{}", ext[0]);
    let with_ext = |p: PathBuf| -> PathBuf {
        let ok = p
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| ext.iter().any(|x| x.eq_ignore_ascii_case(e)));
        if ok {
            p
        } else {
            let mut s = p.into_os_string();
            s.push(format!(".{}", ext[0]));
            PathBuf::from(s)
        }
    };
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("KANSO_PROBE_SAVE_DIR") {
        let p = with_ext(PathBuf::from(dir).join(&suggested));
        return with_grants(&app, |g| g.grant(&p))
            .map(|p| Some(p.to_string_lossy().into_owned()))
            .map_err(|e| e.to_string());
    }
    let window = main_window(&app).ok_or("no-window")?;
    let picked = rfd::AsyncFileDialog::new()
        .set_file_name(&suggested)
        .add_filter(label, ext)
        .set_parent(&window)
        .save_file()
        .await;
    let Some(file) = picked else { return Ok(None) };
    let p = with_ext(file.path().to_path_buf());
    with_grants(&app, |g| g.grant(&p))
        .map(|p| Some(p.to_string_lossy().into_owned()))
        .map_err(|e| e.to_string())
}

/// The palette's "Make Kansowriter the default for .md" (after another app was picked in
/// Finder). Returns the types set. Async: macOS may show a confirmation and wait for it.
#[tauri::command]
async fn set_default_md(app: AppHandle) -> Result<Vec<String>, String> {
    #[allow(unused_mut)]
    let mut types = default_app::current_markdown_types();
    // debug builds only: aim at other types, so testing never changes the person's .md default
    #[cfg(debug_assertions)]
    if let Ok(t) = std::env::var("KANSO_LS_TYPES") {
        types = t.split(',').map(str::to_string).collect();
    }
    default_app::make_default(&app.config().identifier, &types)
}

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
        .invoke_handler(tauri::generate_handler![
            quit_ready,
            take_opened,
            file_read,
            file_stat,
            file_write,
            pick_save_path,
            set_default_md
        ])
        .menu(menu::build)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
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
                })
                .on_page_load(|window, payload| {
                    if payload.event() != PageLoadEvent::Finished {
                        return;
                    }
                    sync_fullscreen(&window, true);
                    #[cfg(debug_assertions)]
                    probe::page_loaded(window);
                });
            builder.build()?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                request_quit(window.app_handle(), quit::Via::Close);
            }
            WindowEvent::Resized(_) => {
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    sync_fullscreen(&w, false);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building Kansowriter")
        .run(|app, event| {
            // Finder, Open With, a drop on the Dock icon, `open -a`: at launch and while running
            if let RunEvent::Opened { urls } = event {
                grant_and_open(app, files::opened_paths(&urls));
            }
        });
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
