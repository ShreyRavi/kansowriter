//! Kansowriter as the default app for the content types macOS uses for .md / .markdown.
//!
//! Once installed it is the default: tauri.conf.json claims .md / .markdown
//! (net.daringfireball.markdown, which macOS declares itself) as an Editor with rank Default, and
//! the page says so once ("Markdown files now open in Kansowriter…"). Rank Alternate was tried
//! first, to only be listed under Open With, but on macOS 26 LaunchServices made the app the
//! implicit default anyway once it had been launched (over an app claiming .md by extension
//! only, VS Code), so the rank now says what happens. The bundle still doesn't import the
//! Markdown type (UTImportedTypeDeclarations): macOS declares it, and importing it isn't needed.
//!
//! The palette's "Make Kansowriter the default for .md" (`make_default`) takes it back after the
//! person picked another app in Finder. LSSetDefaultRoleHandlerForContentType returns noErr and
//! changes nothing on macOS 26, so it uses NSWorkspace's
//! setDefaultApplicationAtURL:toOpenContentType:completionHandler: (macOS 12+), for which macOS
//! may ask the person to confirm.
use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSBundle, NSError, NSString, NSURL};

/// The Markdown type declared by John Gruber and adopted by macOS; .md files carry it.
pub const MARKDOWN_UTI: &str = "net.daringfireball.markdown";
/// kLSRolesAll: viewer, editor and shell
const ROLES_ALL: u32 = 0xFFFF_FFFF;
/// macOS may show a confirmation: give the person time to answer it
const CONFIRM_WAIT: Duration = Duration::from_secs(120);

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSCopyDefaultRoleHandlerForContentType(content_type: *const c_void, role: u32) -> *mut c_void;
    fn UTTypeCreatePreferredIdentifierForTag(
        tag_class: *const c_void,
        tag: *const c_void,
        conforming: *const c_void,
    ) -> *mut c_void;
}

/// NSString is toll-free bridged to CFStringRef.
fn cf(s: &NSString) -> *const c_void {
    s as *const NSString as *const c_void
}

/// Take ownership of a CFStringRef returned by a Copy/Create function.
fn owned(p: *mut c_void) -> Option<String> {
    if p.is_null() {
        return None;
    }
    // SAFETY: a +1 CFStringRef, bridged to NSString; Retained releases it
    let s = unsafe { Retained::from_raw(p as *mut NSString) }?;
    Some(s.to_string())
}

/// The type macOS gives files with this extension right now (a `dyn.` type when nothing declares one).
fn type_for_extension(ext: &str) -> Option<String> {
    let class = NSString::from_str("public.filename-extension");
    let tag = NSString::from_str(ext);
    // SAFETY: valid CFStrings, a null conforming-to type; the result is +1 (Create rule)
    owned(unsafe { UTTypeCreatePreferredIdentifierForTag(cf(&class), cf(&tag), std::ptr::null()) })
}

/// The Markdown UTI first, then whatever macOS maps .md / .markdown to, without repeats.
pub fn markdown_types(found: &[Option<String>]) -> Vec<String> {
    let mut out = vec![MARKDOWN_UTI.to_string()];
    for t in found.iter().flatten() {
        if !t.is_empty() && !out.contains(t) {
            out.push(t.clone());
        }
    }
    out
}

pub fn current_markdown_types() -> Vec<String> {
    markdown_types(&[type_for_extension("md"), type_for_extension("markdown")])
}

/// The bundle id that opens `content_type` now (None when there is no default).
pub fn handler_for(content_type: &str) -> Option<String> {
    let t = NSString::from_str(content_type);
    // SAFETY: a valid CFString; the result is +1 (Copy rule) or null
    owned(unsafe { LSCopyDefaultRoleHandlerForContentType(cf(&t), ROLES_ALL) })
}

/// Make the app at `app` the default for `content_type` (NSWorkspace; macOS may ask to confirm).
fn set_handler(content_type: &str, app: &NSURL) -> Result<(), String> {
    let cls = AnyClass::get(c"UTType").ok_or("UniformTypeIdentifiers unavailable")?;
    let id = NSString::from_str(content_type);
    // SAFETY: +[UTType typeWithIdentifier:] takes an NSString and returns a UTType or nil
    let ty: Option<Retained<AnyObject>> = unsafe { msg_send![cls, typeWithIdentifier: &*id] };
    let ty = ty.ok_or_else(|| format!("{content_type} (unknown type)"))?;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let done = RcBlock::new(move |err: *mut NSError| {
        // SAFETY: the handler gets nil or a valid NSError for the duration of the call
        let result = match unsafe { err.as_ref() } {
            None => Ok(()),
            Some(e) => Err(e.localizedDescription().to_string()),
        };
        let _ = tx.send(result);
    });
    let ws = NSWorkspace::sharedWorkspace();
    // SAFETY: -[NSWorkspace setDefaultApplicationAtURL:toOpenContentType:completionHandler:]
    // (macOS 12+) with an app URL, a UTType and a block taking an NSError *
    unsafe {
        let _: () =
            msg_send![&*ws, setDefaultApplicationAtURL: app, toOpenContentType: &*ty, completionHandler: &*done];
    }
    rx.recv_timeout(CONFIRM_WAIT)
        .map_err(|_| format!("{content_type} (no answer)"))?
        .map_err(|e| format!("{content_type} ({e})"))
}

fn dry_run() -> bool {
    // debug builds only: say what would change without touching the person's defaults
    cfg!(debug_assertions) && std::env::var_os("KANSO_LS_DRY_RUN").is_some()
}

/// Make this app (the running copy) the default for every Markdown type.
pub fn make_default(bundle_id: &str, types: &[String]) -> Result<Vec<String>, String> {
    if dry_run() {
        for t in types {
            eprintln!(
                "[default-app] dry run: {t} is opened by {:?}; would set {bundle_id}",
                handler_for(t)
            );
        }
        return Ok(types.to_vec());
    }
    let me = NSBundle::mainBundle().bundleURL();
    let mut failed = Vec::new();
    for t in types {
        match set_handler(t, &me) {
            Err(e) => failed.push(e),
            // say Yes only when LaunchServices now answers with this app
            Ok(()) if !handler_for(t).is_some_and(|h| h.eq_ignore_ascii_case(bundle_id)) => {
                failed.push(format!("{t} (not applied)"))
            }
            Ok(()) => {}
        }
    }
    if failed.is_empty() {
        Ok(types.to_vec())
    } else {
        Err(failed.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_markdown_uti_comes_first_without_repeats() {
        assert_eq!(markdown_types(&[]), vec![MARKDOWN_UTI]);
        assert_eq!(
            markdown_types(&[Some(MARKDOWN_UTI.into()), Some(MARKDOWN_UTI.into())]),
            vec![MARKDOWN_UTI]
        );
        assert_eq!(
            markdown_types(&[Some("dyn.ah62d4rv4ge8043a".into()), None, Some(String::new())]),
            vec![MARKDOWN_UTI.to_string(), "dyn.ah62d4rv4ge8043a".to_string()]
        );
    }

    #[test]
    fn launch_services_knows_a_type_for_md() {
        // read-only: asks which type .md files get; changes nothing
        let types = current_markdown_types();
        assert_eq!(types[0], MARKDOWN_UTI);
        assert!(type_for_extension("md").is_some());
    }
}
