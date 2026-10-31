//! "Open Markdown files with Kansowriter?": the default app for the content types macOS uses for
//! .md / .markdown. Changed only on the person's answer: Yes (or the palette's "Make Kansowriter
//! the default for .md") makes it this app; Not now gives the default back if macOS handed it to
//! this app on its own.
//!
//! The app only offers itself: tauri.conf.json claims .md / .markdown (net.daringfireball.markdown,
//! which macOS declares itself) as an Editor with rank Alternate, so it is listed under Open With.
//! What was seen on macOS 26 while building this:
//! - rank doesn't stop a takeover: once the app has been launched, LaunchServices picks it as the
//!   implicit default over an app that claims .md by extension only and was never chosen
//!   explicitly (VS Code). Hence Not now gives it back.
//! - importing the type (UTImportedTypeDeclarations) made that happen even before a launch, so
//!   the bundle doesn't.
//! - LSSetDefaultRoleHandlerForContentType returns noErr and changes nothing, so this uses
//!   NSWorkspace's setDefaultApplicationAtURL:toOpenContentType:completionHandler: (macOS 12+),
//!   for which macOS may ask the person to confirm.
use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSArray, NSBundle, NSError, NSString, NSURL};

/// The Markdown type declared by John Gruber and adopted by macOS; .md files carry it.
pub const MARKDOWN_UTI: &str = "net.daringfireball.markdown";
/// kLSRolesAll: viewer, editor and shell
const ROLES_ALL: u32 = 0xFFFF_FFFF;
/// macOS may show a confirmation: give the person time to answer it
const CONFIRM_WAIT: Duration = Duration::from_secs(120);

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSCopyDefaultRoleHandlerForContentType(content_type: *const c_void, role: u32) -> *mut c_void;
    fn LSCopyAllRoleHandlersForContentType(content_type: *const c_void, role: u32) -> *mut c_void;
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

/// Every app that can open `content_type`, in LaunchServices' order (Finder's Open With list).
pub fn handlers_for(content_type: &str) -> Vec<String> {
    let t = NSString::from_str(content_type);
    // SAFETY: a valid CFString; the result is a +1 CFArrayRef of CFStrings (Copy rule) or null
    let p = unsafe { LSCopyAllRoleHandlersForContentType(cf(&t), ROLES_ALL) };
    if p.is_null() {
        return Vec::new();
    }
    // SAFETY: CFArray is toll-free bridged to NSArray; Retained releases it
    let Some(list) = (unsafe { Retained::from_raw(p as *mut NSArray<NSString>) }) else {
        return Vec::new();
    };
    list.iter().map(|s| s.to_string()).collect()
}

/// Who should get a type back from this app: None when this app isn't the default, or no other
/// app can open it. The first other app in LaunchServices' order (the one it would pick).
pub fn previous_default(bundle_id: &str, current: Option<&str>, handlers: &[String]) -> Option<String> {
    if !current.is_some_and(|c| c.eq_ignore_ascii_case(bundle_id)) {
        return None;
    }
    handlers.iter().find(|h| !h.eq_ignore_ascii_case(bundle_id)).cloned()
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

fn app_url(bundle_id: &str) -> Option<Retained<NSURL>> {
    NSWorkspace::sharedWorkspace().URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))
}

fn dry_run() -> bool {
    // debug builds only: say what would change without touching the person's defaults
    cfg!(debug_assertions) && std::env::var_os("KANSO_LS_DRY_RUN").is_some()
}

/// Yes: make this app (the running copy) the default for every Markdown type.
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

/// Not now: where macOS made this app the default on its own, give the type back to the app it
/// would otherwise pick. Returns (type, app) for each one given back.
pub fn give_back(bundle_id: &str, types: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut changed = Vec::new();
    let mut failed = Vec::new();
    for t in types {
        let Some(other) = previous_default(bundle_id, handler_for(t).as_deref(), &handlers_for(t)) else {
            continue;
        };
        if dry_run() {
            eprintln!("[default-app] dry run: this app is the default for {t}; would give it back to {other}");
            continue;
        }
        let Some(url) = app_url(&other) else { continue };
        match set_handler(t, &url) {
            Ok(()) => changed.push((t.clone(), other)),
            Err(e) => failed.push(e),
        }
    }
    if failed.is_empty() {
        Ok(changed)
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
    fn the_default_goes_back_only_when_this_app_took_it_and_another_can_open_it() {
        let me = "com.kansoboard.writer";
        let list = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let all = list(&["com.microsoft.VSCode", me, "com.apple.TextEdit"]);
        assert_eq!(
            previous_default(me, Some(me), &all).as_deref(),
            Some("com.microsoft.VSCode")
        );
        assert_eq!(
            previous_default(me, Some("COM.KANSOBOARD.WRITER"), &list(&[me, "com.apple.TextEdit"])).as_deref(),
            Some("com.apple.TextEdit")
        );
        // someone else is the default: leave it
        assert_eq!(previous_default(me, Some("com.microsoft.VSCode"), &all), None);
        assert_eq!(previous_default(me, None, &all), None);
        // nothing else opens it: stay
        assert_eq!(previous_default(me, Some(me), &list(&[me])), None);
    }

    #[test]
    fn giving_back_changes_nothing_when_this_app_isnt_the_default() {
        // a bundle id that is no one's default: nothing to give back, nothing touched
        assert_eq!(
            give_back("com.kansoboard.writer.test-never-registered", &current_markdown_types()),
            Ok(vec![])
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
