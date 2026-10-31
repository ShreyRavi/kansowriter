//! The menu bar, trimmed to what a writing app needs. Quit is the predefined item: it sends
//! terminate:, which goes through applicationShouldTerminate: (terminate.rs) and so saves first;
//! Close Window sends performClose:, which main.rs routes through the same save-first path. The
//! Edit items are what make ⌘C / ⌘V / ⌘Z reach the text in a WKWebView.
use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
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

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let keys = shortcuts();
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Kansowriter",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Kansowriter"), None)?,
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
    fn the_shortcuts_file_parses_and_open_is_cmd_o() {
        let k = shortcuts();
        assert_eq!(k.open.as_deref(), Some("CmdOrCtrl+O"));
        // ⌘⇧S is the app's "dim other sentences": Save to File must not take it
        assert_ne!(k.save_to_file.as_deref(), Some("Shift+CmdOrCtrl+S"));
        assert_ne!(k.save_kanso.as_deref(), Some("Shift+CmdOrCtrl+S"));
    }
}
