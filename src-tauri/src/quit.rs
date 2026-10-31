//! When the app may quit: the page saves first (src/platform/desktop.ts answers `quit_ready`).
//! Pure state, no AppKit or Tauri, so the rules are unit-tested here; main.rs and terminate.rs
//! act on the outcomes.
//!
//!   begin(Terminate | Close) ─► page saves ─► answer(saved) ─► Proceed | Stay
//!                          └──── QUIT_TIMEOUT ─► timeout(attempt) ─► Proceed
//!
//! A failed save keeps the app open once (Stay); a quit within FORCE_WINDOW of it then goes
//! through whatever the page answers. After that window, or after any clean save, quits wait for
//! a clean save again.
use std::time::{Duration, Instant};

/// The page has this long to answer before the app quits anyway (the page itself gives up at 2 s).
pub const QUIT_TIMEOUT: Duration = Duration::from_secs(3);
/// How long after a failed save the next quit is forced.
pub const FORCE_WINDOW: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    /// applicationShouldTerminate: (⌘Q, Dock, Apple Event, logout): AppKit waits for a reply
    Terminate,
    /// the close button or ⌘W: no reply owed, the app exits itself
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// quit now; `terminate`: reply YES to AppKit (else exit the app ourselves)
    Proceed { terminate: bool },
    /// stay open; `terminate`: reply NO to AppKit (the one intended cancel)
    Stay { terminate: bool },
}

#[derive(Debug)]
struct Pending {
    attempt: u64,
    terminate: bool,
    forced: bool,
}

#[derive(Debug, Default)]
pub struct State {
    pending: Option<Pending>,
    failed_at: Option<Instant>,
    attempts: u64,
}

/// A failed save forces the next quit only for a short while.
pub fn is_forced(failed_at: Option<Instant>, now: Instant) -> bool {
    failed_at.is_some_and(|t| now.saturating_duration_since(t) <= FORCE_WINDOW)
}

impl State {
    pub const fn new() -> Self {
        State {
            pending: None,
            failed_at: None,
            attempts: 0,
        }
    }

    /// A quit was asked for. Returns the new attempt (to ask the page and arm the timeout), or
    /// None when one is already running; a terminate request joining it is answered with it.
    pub fn begin(&mut self, via: Via, now: Instant) -> Option<u64> {
        if let Some(p) = &mut self.pending {
            p.terminate |= via == Via::Terminate;
            return None;
        }
        self.attempts += 1;
        self.pending = Some(Pending {
            attempt: self.attempts,
            terminate: via == Via::Terminate,
            forced: is_forced(self.failed_at, now),
        });
        Some(self.attempts)
    }

    /// The page answered. None when no quit is waiting (a stray call changes nothing).
    pub fn answer(&mut self, saved: bool, now: Instant) -> Option<Outcome> {
        let p = self.pending.take()?;
        if saved {
            self.failed_at = None;
            return Some(Outcome::Proceed { terminate: p.terminate });
        }
        if p.forced {
            return Some(Outcome::Proceed { terminate: p.terminate });
        }
        self.failed_at = Some(now);
        Some(Outcome::Stay { terminate: p.terminate })
    }

    /// The cap fired for `attempt`: quit if that attempt is still waiting.
    pub fn timeout(&mut self, attempt: u64) -> Option<Outcome> {
        if self.pending.as_ref().map(|p| p.attempt) != Some(attempt) {
            return None;
        }
        let p = self.pending.take()?;
        Some(Outcome::Proceed { terminate: p.terminate })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn a_failed_save_forces_quits_only_within_the_window() {
        let t = Instant::now();
        assert!(!is_forced(None, t));
        assert!(is_forced(Some(t), t));
        assert!(is_forced(Some(t), t + S(30)));
        assert!(!is_forced(Some(t), t + S(31)));
        assert!(!is_forced(Some(t), t + S(3600)));
    }

    #[test]
    fn a_clean_save_quits_and_answers_appkit_yes() {
        let mut s = State::default();
        let t = Instant::now();
        assert_eq!(s.begin(Via::Terminate, t), Some(1));
        assert_eq!(s.answer(true, t), Some(Outcome::Proceed { terminate: true }));
        assert_eq!(s.answer(true, t), None, "a stray answer changes nothing");
    }

    #[test]
    fn a_failed_save_stays_once_then_the_next_quit_goes_through() {
        let mut s = State::default();
        let t = Instant::now();
        s.begin(Via::Terminate, t);
        assert_eq!(s.answer(false, t), Some(Outcome::Stay { terminate: true }));
        s.begin(Via::Terminate, t + S(5));
        assert_eq!(s.answer(false, t + S(5)), Some(Outcome::Proceed { terminate: true }));
    }

    #[test]
    fn the_force_expires_so_a_quit_hours_later_waits_for_a_clean_save_again() {
        let mut s = State::default();
        let t = Instant::now();
        s.begin(Via::Close, t);
        assert_eq!(s.answer(false, t), Some(Outcome::Stay { terminate: false }));
        s.begin(Via::Terminate, t + S(3600));
        assert_eq!(s.answer(false, t + S(3600)), Some(Outcome::Stay { terminate: true }));
    }

    #[test]
    fn a_clean_save_clears_the_force() {
        let mut s = State::default();
        let t = Instant::now();
        s.begin(Via::Terminate, t);
        s.answer(false, t);
        s.begin(Via::Terminate, t + S(1));
        assert_eq!(s.answer(true, t + S(1)), Some(Outcome::Proceed { terminate: true }));
        s.begin(Via::Terminate, t + S(2));
        assert_eq!(s.answer(false, t + S(2)), Some(Outcome::Stay { terminate: true }));
    }

    #[test]
    fn the_timeout_quits_only_its_own_attempt() {
        let mut s = State::default();
        let t = Instant::now();
        let first = s.begin(Via::Close, t).unwrap();
        s.answer(true, t);
        let second = s.begin(Via::Close, t + S(1)).unwrap();
        assert_eq!(s.timeout(first), None, "a stale timer never ends a later attempt");
        assert_eq!(s.timeout(second), Some(Outcome::Proceed { terminate: false }));
        assert_eq!(s.timeout(second), None);
    }

    #[test]
    fn a_terminate_joining_a_close_in_progress_is_answered_with_it() {
        let mut s = State::default();
        let t = Instant::now();
        assert!(s.begin(Via::Close, t).is_some());
        assert_eq!(s.begin(Via::Terminate, t), None);
        assert_eq!(s.answer(true, t), Some(Outcome::Proceed { terminate: true }));
    }
}
