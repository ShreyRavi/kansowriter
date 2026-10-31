//! Which commit a build came from, for Kansowriter › About. build.rs includes this file (with
//! `#[path]`) to pick the hash at build time; the app's tests check the rules here.

/// Shown when no commit is known (a source tarball, no git, no Vercel env).
pub const UNKNOWN: &str = "dev";

/// A full or short commit hash, as its 7-character short form; None when it isn't one.
fn short(hash: &str) -> Option<String> {
    let h = hash.trim();
    (h.len() >= 7 && h.chars().all(|c| c.is_ascii_hexdigit())).then(|| h[..7].to_ascii_lowercase())
}

/// `git rev-parse HEAD`, else Vercel's VERCEL_GIT_COMMIT_SHA, else "dev".
pub fn short_sha(git: Option<&str>, vercel: Option<&str>) -> String {
    git.and_then(short)
        .or_else(|| vercel.and_then(short))
        .unwrap_or_else(|| UNKNOWN.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_first_then_vercel_then_dev() {
        let full = "1e564e8c0ffee0000000000000000000000000ab";
        assert_eq!(short_sha(Some(full), Some("ffa8d65aaaa")), "1e564e8");
        assert_eq!(short_sha(Some(&format!("{full}\n")), None), "1e564e8");
        assert_eq!(short_sha(None, Some("FFA8D65AAAA")), "ffa8d65");
        // git printed an error, or nothing: Vercel's, then "dev"
        assert_eq!(
            short_sha(Some("fatal: not a git repository"), Some("ffa8d65")),
            "ffa8d65"
        );
        assert_eq!(short_sha(Some(""), None), "dev");
        assert_eq!(short_sha(None, Some("abc")), "dev");
        assert_eq!(short_sha(None, None), UNKNOWN);
    }
}
