fn main() {
    // listing the app's commands makes each one need an explicit permission (capabilities/main.json)
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "quit_ready",
            "take_opened",
            "file_read",
            "file_stat",
            "file_write",
            "pick_save_path",
            "set_default_md",
        ])),
    )
    .expect("failed to run tauri-build");
}
