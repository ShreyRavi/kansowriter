use std::process::Command;

#[path = "src/build_info.rs"]
#[allow(dead_code)]
mod build_info;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The commit this build comes from, for Kansowriter › About (KANSO_GIT_SHA): git, else Vercel's
/// env, else "dev". Rebuilt when HEAD moves (a checkout, or a commit on the current branch).
fn commit() {
    let vercel = std::env::var("VERCEL_GIT_COMMIT_SHA").ok();
    let sha = build_info::short_sha(git(&["rev-parse", "HEAD"]).as_deref(), vercel.as_deref());
    println!("cargo:rustc-env=KANSO_GIT_SHA={sha}");
    println!("cargo:rerun-if-env-changed=VERCEL_GIT_COMMIT_SHA");
    // --git-path resolves worktrees and the common dir
    let mut watch = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(r) = git(&["symbolic-ref", "-q", "HEAD"]) {
        watch.push(r);
    }
    for p in watch {
        // a missing path would make cargo rerun this on every build
        if let Some(path) = git(&["rev-parse", "--git-path", &p]).filter(|p| std::path::Path::new(p).exists()) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

fn main() {
    commit();
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
