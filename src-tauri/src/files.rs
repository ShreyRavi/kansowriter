//! The files the page may touch: only ones the person handed to this install (opened from Finder,
//! the Dock or `open -a`, or picked in File > Open… / a save panel), and only Markdown or .kanso
//! files. Every grant is kept in the app data dir, so a draft linked to a file keeps saving to it
//! after a restart. Anything else is refused: there is no other file access, and no shell.
//!
//! Pure rules (`normalize`, `Grants`) and the atomic write are unit-tested below; main.rs wires
//! them to commands.
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Kinds of file the app opens and writes.
pub const EXTENSIONS: &[&str] = &["md", "markdown", "kanso"];
/// Largest file read or written (a .kanso holds a whole history; the page caps it at 64 MB too).
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Grants kept, newest last: old ones fall off so the list can't grow without bound.
pub const MAX_GRANTS: usize = 1000;

#[derive(Debug, PartialEq, Eq)]
pub enum FileError {
    /// not a path this install was given
    NotGranted,
    /// relative, has `..`, or isn't a Markdown / .kanso file
    BadPath,
    NotFound,
    TooLarge,
    Io(String),
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileError::NotGranted => write!(f, "not-granted"),
            FileError::BadPath => write!(f, "bad-path"),
            FileError::NotFound => write!(f, "not-found"),
            FileError::TooLarge => write!(f, "too-large"),
            FileError::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl From<std::io::Error> for FileError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            FileError::NotFound
        } else {
            FileError::Io(e.to_string())
        }
    }
}

/// What the page needs to notice a change on disk.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Stat {
    /// modification time, ms since the epoch
    pub mtime: f64,
    pub size: u64,
}

fn has_allowed_extension(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// An absolute path to a Markdown or .kanso file, with no `.` / `..` parts, or BadPath.
pub fn normalize(path: &str) -> Result<PathBuf, FileError> {
    if path.is_empty() || path.contains('\0') {
        return Err(FileError::BadPath);
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(FileError::BadPath);
    }
    if p.components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(FileError::BadPath);
    }
    if !has_allowed_extension(p) || p.file_name().is_none() {
        return Err(FileError::BadPath);
    }
    Ok(p.components().collect())
}

/// The paths this install may read and write.
#[derive(Debug, Default)]
pub struct Grants {
    paths: VecDeque<PathBuf>,
    store: Option<PathBuf>,
}

#[derive(serde::Deserialize, Serialize)]
struct Stored {
    v: u32,
    paths: Vec<PathBuf>,
}

impl Grants {
    /// Grants saved in `store` (none when it is missing or unreadable: only new grants then).
    pub fn load(store: PathBuf) -> Self {
        let mut g = Grants {
            paths: VecDeque::new(),
            store: Some(store.clone()),
        };
        if let Ok(raw) = fs::read(&store) {
            if let Ok(s) = serde_json::from_slice::<Stored>(&raw) {
                if s.v == 1 {
                    for p in s.paths {
                        if let Some(p) = p.to_str().and_then(|s| normalize(s).ok()) {
                            g.push(p);
                        }
                    }
                }
            }
        }
        g
    }

    fn push(&mut self, p: PathBuf) {
        self.paths.retain(|x| x != &p);
        self.paths.push_back(p);
        while self.paths.len() > MAX_GRANTS {
            self.paths.pop_front();
        }
    }

    /// The person handed us this path: allow it from now on. Returns the path as the page will use it.
    pub fn grant(&mut self, path: &Path) -> Result<PathBuf, FileError> {
        let p = normalize(path.to_str().ok_or(FileError::BadPath)?)?;
        self.push(p.clone());
        self.save();
        Ok(p)
    }

    /// The path, when it was granted; NotGranted / BadPath otherwise.
    pub fn check(&self, path: &str) -> Result<PathBuf, FileError> {
        let p = normalize(path)?;
        if self.paths.contains(&p) {
            Ok(p)
        } else {
            Err(FileError::NotGranted)
        }
    }

    fn save(&self) {
        let Some(store) = &self.store else { return };
        let data = Stored {
            v: 1,
            paths: self.paths.iter().cloned().collect(),
        };
        if let Ok(json) = serde_json::to_vec(&data) {
            if let Some(dir) = store.parent() {
                let _ = fs::create_dir_all(dir);
            }
            // the grants file isn't a granted path; write it the same careful way
            let _ = replace_file(store, &json);
        }
    }
}

fn stat_of(meta: &fs::Metadata) -> Stat {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Stat {
        mtime,
        size: meta.len(),
    }
}

/// Size and modification time; None when the file is gone (deleted or moved).
pub fn stat(path: &Path) -> Result<Option<Stat>, FileError> {
    match fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(Some(stat_of(&m))),
        Ok(_) => Err(FileError::Io("not a file".into())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn read(path: &Path) -> Result<Vec<u8>, FileError> {
    let f = fs::File::open(path)?;
    let meta = f.metadata()?;
    if !meta.is_file() {
        return Err(FileError::Io("not a file".into()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    let mut out = Vec::with_capacity(meta.len() as usize);
    // never more than the cap, even if the file grows while it is read
    f.take(MAX_FILE_BYTES + 1).read_to_end(&mut out)?;
    if out.len() as u64 > MAX_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    Ok(out)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to a temporary file beside `target`, flush it to disk, give it the old file's
/// permissions and rename it over the target: readers see the old file or the new one, never half.
fn replace_file(target: &Path, bytes: &[u8]) -> Result<(), FileError> {
    let dir = target.parent().ok_or(FileError::BadPath)?;
    let name = target.file_name().and_then(|n| n.to_str()).ok_or(FileError::BadPath)?;
    let permissions = fs::metadata(target).ok().map(|m| m.permissions());
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.kansowriter-{}-{n}.tmp", std::process::id()));
    let result = (|| {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        if let Some(p) = permissions {
            fs::set_permissions(&tmp, p)?;
        }
        fs::rename(&tmp, target)?;
        Ok::<(), std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| FileError::Io(e.to_string()))
}

/// Atomically replace (or create) the file at `path`. A symlink stays a symlink: its target is
/// what gets replaced.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<Stat, FileError> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    replace_file(&target, bytes)?;
    stat(&target)?.ok_or(FileError::NotFound)
}

/// `file://` URLs from Finder / the Dock / `open -a` that are files the app opens.
pub fn opened_paths(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok())
        .filter(|p| has_allowed_extension(p))
        .collect()
}

/// The page sends a path in a header (raw bodies carry the bytes): percent-encoded UTF-8.
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kansowriter-files-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_absolute_markdown_or_kanso_paths_without_dot_dot() {
        assert!(normalize("/Users/a/notes.md").is_ok());
        assert!(normalize("/Users/a/notes.MARKDOWN").is_ok());
        assert!(normalize("/Users/a/draft.kanso").is_ok());
        assert_eq!(normalize("notes.md"), Err(FileError::BadPath));
        assert_eq!(normalize("/Users/a/../b/notes.md"), Err(FileError::BadPath));
        // `.` and doubled slashes fold away: the same file, one spelling
        assert_eq!(normalize("/Users/a/./notes.md"), Ok(PathBuf::from("/Users/a/notes.md")));
        assert_eq!(normalize("/Users//a/notes.md"), Ok(PathBuf::from("/Users/a/notes.md")));
        assert_eq!(normalize("/etc/passwd"), Err(FileError::BadPath));
        assert_eq!(normalize("/Users/a/.zshrc"), Err(FileError::BadPath));
        assert_eq!(normalize("/Users/a/notes.md.sh"), Err(FileError::BadPath));
        assert_eq!(normalize("/Users/a/no\0te.md"), Err(FileError::BadPath));
        assert_eq!(normalize(""), Err(FileError::BadPath));
        assert_eq!(normalize("/Users/a/x.txt"), Err(FileError::BadPath));
    }

    #[test]
    fn a_path_is_allowed_only_once_granted() {
        let mut g = Grants::default();
        assert_eq!(g.check("/Users/a/notes.md"), Err(FileError::NotGranted));
        g.grant(Path::new("/Users/a/notes.md")).unwrap();
        assert!(g.check("/Users/a/notes.md").is_ok());
        assert_eq!(g.check("/Users/a/other.md"), Err(FileError::NotGranted));
        // a sibling with the same name in another folder, or a parent, is a different path
        assert_eq!(g.check("/Users/b/notes.md"), Err(FileError::NotGranted));
        assert_eq!(g.check("/Users/a/x/../notes.md"), Err(FileError::BadPath));
        assert!(g.grant(Path::new("/Users/a/.ssh/id_rsa")).is_err());
        assert!(g.grant(Path::new("relative.md")).is_err());
    }

    #[test]
    fn grants_survive_a_restart_and_stay_bounded() {
        let dir = scratch("grants");
        let store = dir.join("grants.json");
        let mut g = Grants::load(store.clone());
        g.grant(Path::new("/Users/a/one.md")).unwrap();
        g.grant(Path::new("/Users/a/two.kanso")).unwrap();
        let again = Grants::load(store.clone());
        assert!(again.check("/Users/a/one.md").is_ok());
        assert!(again.check("/Users/a/two.kanso").is_ok());
        // a tampered file can't sneak in a path the rules refuse
        fs::write(
            &store,
            br#"{"v":1,"paths":["/etc/passwd","/Users/a/../x.md","/Users/a/ok.md"]}"#,
        )
        .unwrap();
        let tampered = Grants::load(store.clone());
        assert_eq!(tampered.paths.len(), 1);
        assert!(tampered.check("/Users/a/ok.md").is_ok());
        fs::write(&store, b"not json").unwrap();
        assert!(Grants::load(store.clone()).paths.is_empty());
        let mut many = Grants::default();
        for i in 0..MAX_GRANTS + 5 {
            many.grant(Path::new(&format!("/Users/a/{i}.md"))).unwrap();
        }
        assert_eq!(many.paths.len(), MAX_GRANTS);
        assert_eq!(many.check("/Users/a/0.md"), Err(FileError::NotGranted));
        assert!(many.check(&format!("/Users/a/{}.md", MAX_GRANTS + 4)).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_replace_the_file_atomically_and_keep_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("write");
        let path = dir.join("notes.md");
        fs::write(&path, "old\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let st = write_atomic(&path, b"new text\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new text\n");
        assert_eq!(st.size, 9);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        // no temporary file is left behind
        let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("notes.md")]);
        // a new file is created
        let fresh = dir.join("fresh.md");
        write_atomic(&fresh, b"hi").unwrap();
        assert_eq!(fs::read(&fresh).unwrap(), b"hi");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_symlinked_file_keeps_its_link() {
        let dir = scratch("link");
        let real = dir.join("real.md");
        let link = dir.join("link.md");
        fs::write(&real, "a").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, b"b").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"b");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stat_and_read_report_missing_and_oversized_files() {
        let dir = scratch("stat");
        let path = dir.join("gone.md");
        assert_eq!(stat(&path).unwrap(), None);
        assert_eq!(read(&path), Err(FileError::NotFound));
        fs::write(&path, "x").unwrap();
        assert_eq!(stat(&path).unwrap().unwrap().size, 1);
        assert_eq!(read(&path).unwrap(), b"x");
        let big = OpenOptions::new().write(true).open(&path).unwrap();
        big.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert_eq!(read(&path), Err(FileError::TooLarge));
        assert_eq!(
            write_atomic(&path, &vec![0; MAX_FILE_BYTES as usize + 1]),
            Err(FileError::TooLarge)
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_markdown_and_kanso_files_are_taken_from_open_events() {
        let urls = [
            tauri::Url::parse("file:///Users/a/My%20Notes.md").unwrap(),
            tauri::Url::parse("file:///Users/a/d.kanso").unwrap(),
            tauri::Url::parse("file:///Users/a/photo.png").unwrap(),
            tauri::Url::parse("https://example.com/x.md").unwrap(),
        ];
        assert_eq!(
            opened_paths(&urls),
            vec![PathBuf::from("/Users/a/My Notes.md"), PathBuf::from("/Users/a/d.kanso")]
        );
    }

    #[test]
    fn header_paths_decode_from_percent_encoding() {
        assert_eq!(
            percent_decode("%2FUsers%2Fa%2FMy%20Notes.md").as_deref(),
            Some("/Users/a/My Notes.md")
        );
        assert_eq!(
            percent_decode("%2Ftmp%2F%C3%A9t%C3%A9.md").as_deref(),
            Some("/tmp/été.md")
        );
        assert_eq!(percent_decode("%2"), None);
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%FF"), None);
    }
}
