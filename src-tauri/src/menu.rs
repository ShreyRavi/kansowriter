//! The menu bar, trimmed to what a writing app needs. Quit is the predefined item: it sends
//! terminate:, which goes through applicationShouldTerminate: (terminate.rs) and so saves first;
//! Close Window sends performClose:, which main.rs routes through the same save-first path. The
//! Edit items are what make ⌘C / ⌘V / ⌘Z reach the text in a WKWebView.
use serde::Deserialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

pub const OPEN: &str = "open";
pub const SAVE_TO_FILE: &str = "save-file";
pub const SAVE_KANSO: &str = "save-kanso";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Custom {
    open: Option<String>,
    save_to_file: Option<String>,
    save_kanso: Option<String>,
}

#[derive(Deserialize)]
struct Shortcuts {
    custom: Custom,
}

fn shortcuts() -> Custom {
    // the same file the page's tests check against the app's own shortcuts
    serde_json::from_str::<Shortcuts>(include_str!("../menu-shortcuts.json"))
        .expect("menu-shortcuts.json")
        .custom
}

pub const SOURCE: &str = "https://github.com/ShreyRavi/kansowriter";

/// Kansowriter › About: "Version 0.1.0 (1e564e8)" (the commit build.rs found) and where the
/// source lives. macOS shows `version` with `short_version` in parentheses and ignores
/// `website`, so the link is in `credits` too (plain text there).
fn about(version: &str, sha: &str) -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some("Kansowriter".into()),
        version: Some(version.into()),
        short_version: Some(sha.into()),
        website: Some(SOURCE.into()),
        website_label: Some("Source code".into()),
        credits: Some(format!("Source code: {SOURCE}")),
        copyright: Some("Kansoboard".into()),
        ..Default::default()
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let keys = shortcuts();
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Kansowriter",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some("About Kansowriter"),
                Some(about(&app.package_info().version.to_string(), env!("KANSO_GIT_SHA"))),
            )?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, OPEN, "Open…", true, keys.open.as_deref())?,
            &sep()?,
            &MenuItem::with_id(app, SAVE_TO_FILE, "Save to File…", true, keys.save_to_file.as_deref())?,
            &MenuItem::with_id(
                app,
                SAVE_KANSO,
                "Save as Kansowriter File (.kanso)…",
                true,
                keys.save_kanso.as_deref(),
            )?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &window])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_shows_the_version_with_the_commit_and_the_source() {
        let a = about("0.1.0", "1e564e8");
        assert_eq!(a.version.as_deref(), Some("0.1.0"));
        assert_eq!(a.short_version.as_deref(), Some("1e564e8"));
        assert_eq!(a.website.as_deref(), Some(SOURCE));
        assert_eq!(a.website_label.as_deref(), Some("Source code"));
        assert!(a.credits.unwrap().contains(SOURCE));
        // this build's commit was found (or the documented fallback)
        let sha = env!("KANSO_GIT_SHA");
        assert!(sha == crate::build_info::UNKNOWN || (sha.len() == 7 && sha.chars().all(|c| c.is_ascii_hexdigit())));
    }

    #[test]
    fn the_shortcuts_file_parses_and_open_is_cmd_o() {
        let k = shortcuts();
        assert_eq!(k.open.as_deref(), Some("CmdOrCtrl+O"));
        // ⌘⇧S is the app's "dim other sentences": Save to File must not take it
        assert_ne!(k.save_to_file.as_deref(), Some("Shift+CmdOrCtrl+S"));
        assert_ne!(k.save_kanso.as_deref(), Some("Shift+CmdOrCtrl+S"));
    }
}
