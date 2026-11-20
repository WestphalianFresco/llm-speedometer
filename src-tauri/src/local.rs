//! The transcripts Claude Code writes under `~/.claude/projects/**/*.jsonl`:
//! the odometer, the trip, and the turn events the rate and the tanks are
//! read from.
//!
//! Cache reads are excluded everywhere, exactly as in the Electron app: they
//! run orders of magnitude above everything else and would drown the reading.
//! What is counted is input + cache writes + output.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::pricing::cost_of;

pub const FIVE_HOURS_MS: i64 = 5 * 3600 * 1000;
pub const SEVEN_DAYS_MS: i64 = 7 * 24 * 3600 * 1000;

/// Only the trailing window matters for the rate, and the week for the tanks;
/// a day of slack past the week lets a late anchor still be reconciled.
pub const RETENTION_MS: i64 = 8 * 24 * 3600 * 1000;

/// One API response: when, what it cost at list price, and its tokens.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub ts: i64,
    pub cost: f64,
    pub output: u64,
    pub tokens: u64,
    pub model: String,
}

/// What the newest main-thread turn said about the session it belongs to.
/// Sidechain records are subagents, at their own model and effort.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Last {
    pub version: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Tally {
    pub tokens: u64,
    pub turns: u64,
    pub events: Vec<Event>,
    pub last: Last,
}

#[derive(Clone)]
struct Entry {
    mtime: Option<SystemTime>,
    size: u64,
    tally: Tally,
}

#[derive(Debug, Default)]
pub struct Scan {
    pub total: u64,
    pub turns: u64,
    pub files: usize,
    pub trip: u64,
    pub trip_turns: u64,
    pub trip_session_id: Option<String>,
    pub last: Last,
    pub events: Vec<Event>,
}

/// Re-reads only transcripts whose mtime or size moved since the last scan.
#[derive(Default)]
pub struct Scanner {
    cache: HashMap<PathBuf, Entry>,
}

impl Scanner {
    pub fn scan(&mut self, projects: &Path, now: i64) -> Scan {
        let mut out = Scan::default();
        let mut live = HashSet::new();
        let mut newest: Option<(SystemTime, String, Tally)> = None;

        let Ok(dirs) = fs::read_dir(projects) else { return out };
        for project in dirs.flatten() {
            let dir = project.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(names) = fs::read_dir(&dir) else { continue };
            for name in names.flatten() {
                let file = name.path();
                if file.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(entry) = self.entry_for(&file, now) else { continue };
                live.insert(file.clone());
                out.total += entry.tally.tokens;
                out.turns += entry.tally.turns;
                out.files += 1;
                out.events.extend(entry.tally.events.iter().cloned());
                if let Some(mtime) = entry.mtime {
                    if newest.as_ref().map(|(m, _, _)| mtime > *m).unwrap_or(true) {
                        let id = file.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                        newest = Some((mtime, id, entry.tally.clone()));
                    }
                }
            }
        }
        // Drop transcripts no longer on disk, or the cache keeps counting them.
        self.cache.retain(|k, _| live.contains(k));

        if let Some((_, id, tally)) = newest {
            out.trip = tally.tokens;
            out.trip_turns = tally.turns;
            out.trip_session_id = Some(id);
            out.last = tally.last;
        }
        out.events.sort_by_key(|e| e.ts);
        out
    }

    /// The model a transcript last used, by session id, from the cache: the
    /// live-session strip asks for a few of these every tick.
    pub fn model_of(&self, session_id: &str) -> Option<String> {
        self.cache.iter().find(|(p, _)| p.file_stem().and_then(|s| s.to_str()) == Some(session_id)).and_then(|(_, e)| e.tally.last.model.clone())
    }

    fn entry_for(&mut self, file: &Path, now: i64) -> Option<Entry> {
        let meta = fs::metadata(file).ok()?;
        let mtime = meta.modified().ok();
        let size = meta.len();
        if let Some(cached) = self.cache.get(file) {
            if cached.mtime == mtime && cached.size == size {
                return Some(cached.clone());
            }
        }
        // ponytail: a changed transcript is re-parsed whole (a few MB for the
        // live one, every 20 s); carry an offset and the last id if that ever
        // shows in a profile.
        let bytes = fs::read(file).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        let entry = Entry { mtime, size, tally: tally(&text, now) };
        self.cache.insert(file.to_path_buf(), entry.clone());
        Some(entry)
    }
}

/// Tally one transcript's text.
pub fn tally(text: &str, now: i64) -> Tally {
    let mut out = Tally::default();
    let mut last_id: Option<String> = None;
    for line in text.lines() {
        // Most lines are user turns, tool results and metadata with no usage.
        if line.len() < 40 || !line.contains("\"usage\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(message) = record.get("message") else { continue };
        let Some(usage) = message.get("usage") else { continue };
        // One response is written as several lines, one per content block,
        // each repeating the same usage. They are consecutive, so skipping a
        // repeat of the id just counted collapses them into one response.
        if let Some(id) = message.get("id").and_then(|v| v.as_str()) {
            if last_id.as_deref() == Some(id) {
                continue;
            }
            last_id = Some(id.to_string());
        }
        let n = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        let output = n("output_tokens");
        let tokens = n("input_tokens") + n("cache_creation_input_tokens") + output;
        out.turns += 1;
        out.tokens += tokens;

        let text_of = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).map(str::to_string);
        let model = text_of(message.get("model")).unwrap_or_default();
        if record.get("isSidechain").and_then(|v| v.as_bool()) != Some(true) && !model.is_empty() {
            out.last.version = text_of(record.get("version")).or(out.last.version.take());
            out.last.model = Some(model.clone());
            out.last.effort = text_of(record.get("effort"));
            out.last.cwd = text_of(record.get("cwd")).or(out.last.cwd.take());
        }

        // Synthetic turns carry a usage block with nothing in it.
        let cost = cost_of(usage, &model, "anthropic");
        if cost <= 0.0 {
            continue;
        }
        if let Some(ts) = record.get("timestamp").and_then(|v| v.as_str()).and_then(parse_iso_ms) {
            if ts > now - RETENTION_MS {
                out.events.push(Event { ts, cost, output, tokens, model });
            }
        }
    }
    out
}

/// Output tokens per minute over the trailing `window_ms`. Cache reads and
/// writes are context bookkeeping, not generation, and would swamp this.
pub fn rate_per_minute(events: &[Event], now: i64, window_ms: i64) -> f64 {
    let since = now - window_ms;
    let output: u64 = events.iter().filter(|e| e.ts > since && e.ts <= now).map(|e| e.output).sum();
    output as f64 / (window_ms as f64 / 60_000.0)
}

/// List-price dollars of the events inside `[from, to]`.
pub fn spend_between(events: &[Event], from: i64, to: i64) -> f64 {
    // `+ 0.0`: an empty f64 sum is -0.0, which the page would print as "$-0.00"
    events.iter().filter(|e| e.ts >= from && e.ts <= to).map(|e| e.cost).sum::<f64>() + 0.0
}

pub fn spend_since(events: &[Event], since: i64) -> f64 {
    events.iter().filter(|e| e.ts >= since).map(|e| e.cost).sum::<f64>() + 0.0
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WindowTally {
    pub tokens: u64,
    pub cost: f64,
    pub turns: u64,
    pub from: i64,
    pub to: i64,
    /// How much of the window local history can vouch for: retention holds
    /// eight days, but a fresh install or a machine that was off covers less.
    pub covered: f64,
}

pub fn window_tally(events: &[Event], from: i64, to: i64, now: i64) -> WindowTally {
    let mut t = WindowTally { from, to, ..Default::default() };
    for e in events.iter().filter(|e| e.ts >= from && e.ts <= to) {
        t.tokens += e.tokens;
        t.cost += e.cost;
        t.turns += 1;
    }
    let span = (to - from).max(1) as f64;
    let oldest = events.first().map(|e| e.ts.min(to)).unwrap_or(from);
    let horizon = from.max((now - RETENTION_MS).min(to)).max(oldest);
    t.covered = ((to - horizon) as f64 / span).clamp(0.0, 1.0);
    t
}

/// `2026-11-06T03:37:09.404Z` to epoch milliseconds. Claude Code writes UTC
/// with a `Z`; the usage endpoint writes an offset (`+00:00`). Either is
/// taken, with or without fractional seconds; anything else is not a
/// timestamp this reader trusts.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    if s.len() < 20 {
        return None;
    }
    let num = |from: usize, len: usize| -> Option<i64> { s.get(from..from + len)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (h, mi, se) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if s.as_bytes().get(10) != Some(&b'T') || !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut ms = 0;
    if let Some(after_dot) = rest.strip_prefix('.') {
        let digits = after_dot.chars().take_while(|c| c.is_ascii_digit()).count();
        let f: i64 = after_dot[..digits].parse().ok()?;
        ms = match digits {
            0 => return None,
            1 => f * 100,
            2 => f * 10,
            3 => f,
            n => f / 10_i64.pow((n - 3) as u32),
        };
        rest = &after_dot[digits..];
    }
    let offset_s = match rest {
        "Z" => 0,
        tz if tz.len() == 6 && (tz.starts_with('+') || tz.starts_with('-')) && tz.as_bytes()[3] == b':' => {
            let sign = if tz.starts_with('-') { -1 } else { 1 };
            let (oh, om) = (tz[1..3].parse::<i64>().ok()?, tz[4..6].parse::<i64>().ok()?);
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 3600 + om * 60)
        }
        _ => return None,
    };
    Some((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset_s) * 1000 + ms)
}

// Howard Hinnant's days_from_civil: days since 1970-01-01 for a Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_936_229_404; // 2026-11-06T03:37:09.404Z

    fn line(id: &str, ts: &str, input: u64, cache_w: u64, cache_r: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","cwd":"/w","version":"2.1.317","message":{{"id":"{id}","model":"claude-opus-5-5","usage":{{"input_tokens":{input},"cache_creation_input_tokens":{cache_w},"cache_read_input_tokens":{cache_r},"output_tokens":{output}}}}}}}"#
        )
    }

    #[test]
    fn parses_claude_code_timestamps_and_rejects_the_rest() {
        assert_eq!(parse_iso_ms("2026-11-06T03:37:09.404Z"), Some(NOW));
        assert_eq!(parse_iso_ms("2026-11-06T03:37:09Z"), Some(NOW - 404));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-11-06T03:37:09.4Z"), Some(NOW - 4));
        assert_eq!(parse_iso_ms("2026-11-06T03:37:09.404123Z"), Some(NOW));
        // the usage endpoint's form: an offset instead of Z
        assert_eq!(parse_iso_ms("2026-11-06T03:37:09.404+00:00"), Some(NOW));
        assert_eq!(parse_iso_ms("2026-11-05T22:37:09-05:00"), Some(NOW - 404));
        assert_eq!(parse_iso_ms("2026-11-06T04:37:09+01:00"), Some(NOW - 404));
        for junk in ["", "yesterday", "2026-11-06T03:37:09", "2026-13-06T03:37:09.404Z", "2026-11-06T03:37:09.Z", "2026-11-06T03:37:09+0100", "2026-11-06 03:37:09Z"] {
            assert_eq!(parse_iso_ms(junk), None, "{junk}");
        }
    }

    #[test]
    fn counts_one_response_once_and_leaves_cache_reads_out() {
        let text = [
            line("m1", "2026-11-06T03:30:00.000Z", 2, 30890, 28950, 281),
            line("m1", "2026-11-06T03:30:00.000Z", 2, 30890, 28950, 281), // same response, next content block
            line("m2", "2026-11-06T03:36:00.000Z", 10, 0, 999_999, 90),
            line("m3", "2026-11-06T03:36:30.000Z", 0, 0, 0, 0), // synthetic: counted as a turn, no event
            "{\"type\":\"user\",\"message\":{\"role\":\"user\"}}".to_string(),
            "not json at all, but long enough to hold the word \"usage\" in it".to_string(),
        ]
        .join("\n");
        let t = tally(&text, NOW);
        assert_eq!(t.turns, 3);
        assert_eq!(t.tokens, 2 + 30890 + 281 + 10 + 90);
        assert_eq!(t.events.len(), 2);
        assert_eq!(t.last, Last { version: Some("2.1.317".into()), model: Some("claude-opus-5-5".into()), effort: None, cwd: Some("/w".into()) });
        assert!(t.events.iter().all(|e| e.cost > 0.0 && e.model == "claude-opus-5-5"));
        // output only, over the trailing ten minutes: 281 + 90 over 10 min
        assert_eq!(rate_per_minute(&t.events, NOW, 10 * 60_000), 37.1);
        // the first response has aged out of a five-minute window
        assert_eq!(rate_per_minute(&t.events, NOW, 5 * 60_000), 18.0);
    }

    #[test]
    fn a_window_tally_counts_its_span_and_says_how_much_it_covers() {
        let ev = |ts: i64, tokens: u64| Event { ts, cost: 0.01, output: 1, tokens, model: "m".into() };
        let events = vec![ev(NOW - 3 * 3600_000, 100), ev(NOW - 3600_000, 200), ev(NOW, 300)];
        let t = window_tally(&events, NOW - 2 * 3600_000, NOW, NOW);
        assert_eq!((t.tokens, t.turns), (500, 2));
        assert!((t.cost - 0.02).abs() < 1e-12);
        assert_eq!(t.covered, 1.0);
        // a week-long window with three hours of history is barely covered
        let week = window_tally(&events, NOW - SEVEN_DAYS_MS, NOW, NOW);
        assert!(week.covered < 0.02 && week.covered > 0.0);
        // no history at all: nothing contradicts the window, as in the Electron store
        assert_eq!(window_tally(&[], NOW - 60_000, NOW, NOW).covered, 1.0);
        assert!(spend_since(&[], NOW).is_sign_positive());
        assert!((spend_between(&events, NOW - 3600_000, NOW) - 0.02).abs() < 1e-12);
        assert!((spend_since(&events, NOW) - 0.01).abs() < 1e-12);
    }

    #[test]
    fn old_events_are_not_kept() {
        let text = line("m1", "2026-10-01T00:00:00.000Z", 5, 0, 0, 5);
        let t = tally(&text, NOW);
        assert_eq!(t.turns, 1);
        assert!(t.events.is_empty());
    }

    #[test]
    fn scanner_reads_changed_files_only_and_follows_the_newest() {
        let dir = std::env::temp_dir().join(format!("speedo-scan-{}", std::process::id()));
        let project = dir.join("-Users-x-proj");
        fs::create_dir_all(&project).unwrap();
        let a = project.join("aaaa.jsonl");
        let b = project.join("bbbb.jsonl");
        fs::write(&a, line("a1", "2026-11-06T03:00:00.000Z", 100, 0, 0, 10)).unwrap();
        fs::write(&b, line("b1", "2026-11-06T03:30:00.000Z", 200, 0, 0, 20)).unwrap();
        // b is newer by mtime
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        fs::File::open(&b).unwrap().set_modified(later).unwrap();

        let mut s = Scanner::default();
        let first = s.scan(&dir, NOW);
        assert_eq!((first.total, first.turns, first.files), (330, 2, 2));
        assert_eq!((first.trip, first.trip_turns, first.trip_session_id.as_deref()), (220, 1, Some("bbbb")));
        assert_eq!(first.events.len(), 2);

        // untouched: same answer, served from the cache
        let again = s.scan(&dir, NOW);
        assert_eq!(again.total, 330);

        // a grows, b disappears
        fs::write(&a, format!("{}\n{}", line("a1", "2026-11-06T03:00:00.000Z", 100, 0, 0, 10), line("a2", "2026-11-06T03:35:00.000Z", 1, 0, 0, 1))).unwrap();
        fs::remove_file(&b).unwrap();
        let third = s.scan(&dir, NOW);
        assert_eq!((third.total, third.turns, third.files), (112, 2, 1));
        assert_eq!(third.trip_session_id.as_deref(), Some("aaaa"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
