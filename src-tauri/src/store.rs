//! The quota windows: official anchors, the learned conversion from local
//! spend to percent, and the token budgets derived from both. A port of the
//! Electron store, reading and writing the same `state.json`.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::SystemTime;

use crate::local::{self, Event, FIVE_HOURS_MS, SEVEN_DAYS_MS};
use crate::official::{Fetch, Reading};
use crate::pricing::price_meta;

/// An anchor older than this is too stale to project from with a straight face.
pub const MAX_ANCHOR_AGE_MS: i64 = 90 * 60 * 1000;
/// Below this much spend, an anchor's implied rate is mostly noise.
const MIN_SPEND_FOR_CALIBRATION: f64 = 0.5;
const CALIBRATION_ALPHA: f64 = 0.35;
/// capacity = tokens / (percent/100): below this the whole-number percentages
/// the endpoint sends make the division swing by more than the answer is worth.
const MIN_PERCENT_FOR_BUDGET: f64 = 8.0;
/// A window's token count only means something next to its percentage if
/// local history covers the window.
const MIN_COVERAGE_FOR_BUDGET: f64 = 0.98;
/// A session file older than this was left by a session that stopped writing.
pub const SESSION_FILE_MAX_AGE_MS: i64 = 15 * 60 * 1000;
const RATE_WINDOW_MS: i64 = 10 * 60 * 1000;

pub const KEYS: [&str; 3] = ["fiveHour", "sevenDay", "weeklyScoped"];

fn span_of(key: &str) -> i64 {
    if key == "fiveHour" { FIVE_HOURS_MS } else { SEVEN_DAYS_MS }
}
fn label_of(key: &str) -> &'static str {
    match key {
        "fiveHour" => "5-hour",
        "sevenDay" => "This week",
        _ => "Week / model",
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub at: i64,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
    pub scope: Option<String>,
}

/// When a window actually opened. Windows are fixed, not trailing: the reset
/// is a wall-clock moment the endpoint reports, and `resets_at - span` is
/// where it began. A reset already in the past rolled over while nobody was
/// looking; walk it forward to the cycle we are in.
pub fn window_start(resets_at: Option<i64>, span: i64, now: i64) -> i64 {
    match resets_at {
        None => now - span,
        Some(r) if r <= now => (r + ((now - r) / span) * span).min(now),
        Some(r) => (r - span).min(now),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub percent: Option<f64>,
    pub source: &'static str,
    pub confidence: &'static str,
    pub anchor_at: Option<i64>,
    pub resets_at: Option<i64>,
}

pub struct UsageStore {
    state_path: Option<PathBuf>,
    session_file: Option<PathBuf>,
    session_file_mtime: Option<SystemTime>,
    pub anchors: HashMap<String, Anchor>,
    /// Percent of quota per USD of local spend, learned by comparing an
    /// official reading against the local spend in the same window.
    pub calibration: HashMap<String, f64>,
    /// Tokens per percent of quota: the only way to name a token budget, since
    /// the endpoint reports no token count anywhere.
    pub token_calibration: HashMap<String, f64>,
    pub official_spend: Option<Value>,
    pub last_official_attempt: Option<Value>,
}

impl UsageStore {
    pub fn new(state_path: Option<PathBuf>, session_file: Option<PathBuf>) -> Self {
        let mut store = Self {
            state_path,
            session_file,
            session_file_mtime: None,
            anchors: HashMap::new(),
            calibration: HashMap::new(),
            token_calibration: HashMap::new(),
            official_spend: None,
            last_official_attempt: None,
        };
        store.load();
        store
    }

    fn load(&mut self) {
        let Some(saved) = self.state_path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return };
        for key in KEYS {
            if let Some(a) = saved.get("anchors").and_then(|a| a.get(key)).filter(|a| a.is_object()) {
                if let (Some(at), Some(used)) = (a.get("at").and_then(|v| v.as_i64()), a.get("usedPercent").and_then(|v| v.as_f64())) {
                    self.anchors.insert(key.into(), Anchor {
                        at,
                        used_percent: used,
                        resets_at: a.get("resetsAt").and_then(|v| v.as_i64()),
                        scope: a.get("scope").and_then(|v| v.as_str()).map(str::to_string),
                    });
                }
            }
            for (field, map) in [("calibration", &mut self.calibration), ("tokenCalibration", &mut self.token_calibration)] {
                if let Some(n) = saved.get(field).and_then(|c| c.get(key)).and_then(|v| v.as_f64()).filter(|n| n.is_finite() && *n > 0.0) {
                    map.insert(key.into(), n);
                }
            }
        }
        self.official_spend = saved.get("officialSpend").filter(|v| v.is_object()).cloned();
    }

    pub fn save(&self) {
        let Some(path) = &self.state_path else { return };
        let anchors: serde_json::Map<String, Value> = KEYS.iter().map(|k| (k.to_string(), self.anchors.get(*k).map(anchor_json).unwrap_or(Value::Null))).collect();
        let nums = |m: &HashMap<String, f64>| -> serde_json::Map<String, Value> { KEYS.iter().map(|k| (k.to_string(), m.get(*k).map(|n| json!(n)).unwrap_or(Value::Null))).collect() };
        let text = serde_json::to_string_pretty(&json!({
            "anchors": anchors,
            "calibration": nums(&self.calibration),
            "tokenCalibration": nums(&self.token_calibration),
            "officialSpend": self.official_spend,
            "savedAt": crate::now_ms(),
        })).unwrap_or_default();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // a widget must never die over a cache write
        let _ = std::fs::write(path, text);
    }

    fn learn(&mut self, key: &str, reading: &Reading, at: i64, events: &[Event], now: i64) {
        let start = window_start(reading.resets_at, span_of(key), at);
        let tally = local::window_tally(events, start, at, now);
        let usable = reading.used_percent > 1.0 && reading.used_percent < 99.5;
        if usable && tally.cost >= MIN_SPEND_FOR_CALIBRATION {
            let observed = reading.used_percent / tally.cost;
            let next = match self.calibration.get(key) { Some(prior) => prior * (1.0 - CALIBRATION_ALPHA) + observed * CALIBRATION_ALPHA, None => observed };
            self.calibration.insert(key.into(), next);
        }
        if usable && tally.tokens > 0 && reading.used_percent >= MIN_PERCENT_FOR_BUDGET && tally.covered >= MIN_COVERAGE_FOR_BUDGET {
            let observed = tally.tokens as f64 / reading.used_percent;
            let next = match self.token_calibration.get(key) { Some(prior) => prior * (1.0 - CALIBRATION_ALPHA) + observed * CALIBRATION_ALPHA, None => observed };
            self.token_calibration.insert(key.into(), next);
        }
        self.anchors.insert(key.into(), Anchor { at, used_percent: reading.used_percent, resets_at: reading.resets_at, scope: reading.scope.clone() });
    }

    /// Fold a usage-endpoint answer into the anchors and the calibration.
    pub fn ingest_official(&mut self, fetch: &Fetch, events: &[Event], now: i64) -> bool {
        self.last_official_attempt = Some(json!({ "at": now, "status": fetch.status, "reason": fetch.reason, "retryAt": fetch.retry_at }));
        if fetch.status != "ok" {
            return false;
        }
        if let Some(s) = &fetch.parsed.spend {
            self.official_spend = Some(json!({ "usedUsd": s.used_usd, "limitUsd": s.limit_usd, "currency": s.currency, "enabled": s.enabled, "percent": s.percent, "at": fetch.at }));
        }
        let readings = [("fiveHour", &fetch.parsed.five_hour), ("sevenDay", &fetch.parsed.seven_day), ("weeklyScoped", &fetch.parsed.weekly_scoped)];
        for (key, reading) in readings {
            if let Some(r) = reading {
                self.learn(key, r, fetch.at, events, now);
            }
        }
        self.save();
        true
    }

    /// The reading a Claude Code session running the plugin leaves beside the
    /// bridge file: the same percentages the endpoint reports, taken from the
    /// rate-limit headers of every reply. Only a window the file has, only
    /// while it is fresh, never over an anchor newer than the file.
    pub fn ingest_session_file(&mut self, events: &[Event], now: i64) -> bool {
        let Some(path) = &self.session_file else { return false };
        let Ok(meta) = std::fs::metadata(path) else { return false };
        let mtime = meta.modified().ok();
        if mtime.is_some() && mtime == self.session_file_mtime {
            return false;
        }
        self.session_file_mtime = mtime;
        let Some(r) = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return false };
        if r.get("v").and_then(|v| v.as_i64()) != Some(1) || r.get("source").and_then(|v| v.as_str()) != Some("claude-code") {
            return false;
        }
        let Some(at) = r.get("at").and_then(|v| v.as_i64()) else { return false };
        if now - at > SESSION_FILE_MAX_AGE_MS {
            return false;
        }
        let mut taken = false;
        for key in ["fiveHour", "sevenDay"] {
            let Some(left) = r.get(key).and_then(|t| t.get("percentLeft")).and_then(|v| v.as_f64()).filter(|n| n.is_finite()) else { continue };
            if self.anchors.get(key).map(|a| a.at > at).unwrap_or(false) {
                continue;
            }
            let reading = Reading {
                used_percent: (100.0 - left).clamp(0.0, 100.0),
                resets_at: r.get(key).and_then(|t| t.get("resetsAt")).and_then(|v| v.as_i64()),
                severity: None,
                scope: None,
            };
            self.learn(key, &reading, at, events, now);
            taken = true;
        }
        if taken {
            self.last_official_attempt = Some(json!({ "at": now, "status": "ok", "reason": null, "via": "session_file" }));
            self.save();
        }
        taken
    }

    pub fn resolve_window(&self, key: &str, events: &[Event], now: i64) -> Resolved {
        let span = span_of(key);
        let anchor = self.anchors.get(key);
        let rate = self.calibration.get(key).copied();
        let rolled = anchor.map(|a| a.resets_at.map(|r| now >= r).unwrap_or(false)).unwrap_or(false);
        let stale = anchor.map(|a| now - a.at > MAX_ANCHOR_AGE_MS).unwrap_or(false);

        if let Some(a) = anchor.filter(|_| !rolled && !stale) {
            let delta = local::spend_between(events, a.at, now);
            return match rate {
                Some(rate) if delta > 0.0 => Resolved {
                    percent: Some((a.used_percent + delta * rate).clamp(0.0, 100.0)),
                    source: "hybrid",
                    confidence: "projected",
                    anchor_at: Some(a.at),
                    resets_at: a.resets_at,
                },
                _ => Resolved { percent: Some(a.used_percent.clamp(0.0, 100.0)), source: "official", confidence: "exact", anchor_at: Some(a.at), resets_at: a.resets_at },
            };
        }
        // No usable anchor: a pure local projection from the most recent reset
        // boundary, which may be several cycles past a rolled anchor's own.
        let start = window_start(anchor.and_then(|a| a.resets_at), span, now);
        let next_reset = anchor.and_then(|a| a.resets_at).map(|_| start + span);
        let spend = local::spend_since(events, start);
        match rate {
            None => Resolved { percent: None, source: "uncalibrated", confidence: "unknown", anchor_at: anchor.map(|a| a.at), resets_at: next_reset },
            Some(rate) => Resolved { percent: Some((spend * rate).clamp(0.0, 100.0)), source: "local", confidence: "estimated", anchor_at: anchor.map(|a| a.at), resets_at: next_reset },
        }
    }

    /// A window in tokens. `used` is measured from the transcripts;
    /// `remaining` is the official percentage against a window size learned
    /// from how many tokens it took to move that percentage. Deliberately not
    /// two halves of one subtraction: when they disagree the gap is real.
    pub fn budget(&self, key: &str, resolved: &Resolved, events: &[Event], now: i64) -> Value {
        let span = span_of(key);
        let start = window_start(resolved.resets_at, span, now);
        let tally = local::window_tally(events, start, now, now);
        let mut out = json!({
            "windowStart": start,
            "resetsAt": resolved.resets_at,
            "usedTokens": tally.tokens,
            "usedCost": tally.cost,
            "turns": tally.turns,
            "covered": tally.covered,
            "capacityTokens": null,
            "remainingTokens": null,
            "confidence": "unknown",
        });
        if let (Some(per_percent), Some(percent)) = (self.token_calibration.get(key), resolved.percent) {
            let capacity = per_percent * 100.0;
            out["capacityTokens"] = json!(capacity);
            // From the percentage rather than capacity minus used, so a machine
            // that missed part of the window still reports the right headroom.
            out["remainingTokens"] = json!((capacity * (100.0 - percent.clamp(0.0, 100.0)) / 100.0).max(0.0));
            out["confidence"] = json!(if resolved.source != "official" && resolved.source != "hybrid" {
                "projected"
            } else if tally.covered >= MIN_COVERAGE_FOR_BUDGET && percent >= MIN_PERCENT_FOR_BUDGET {
                "measured"
            } else {
                "carried"
            });
        }
        out
    }

    /// The quota half of the payload the page draws from.
    /// `official` is the poller's state: next poll time, backing off, last error.
    pub fn read(&self, events: &[Event], official: (i64, bool, Option<String>), now: i64, plan: Option<&str>) -> Value {
        let window_json = |key: &str, r: &Resolved| {
            json!({ "percent": r.percent, "source": r.source, "confidence": r.confidence, "anchorAt": r.anchor_at, "resetsAt": r.resets_at, "label": label_of(key) })
        };
        let five = self.resolve_window("fiveHour", events, now);
        let seven = self.resolve_window("sevenDay", events, now);
        // The per-model cap only while an official reading stands: projecting
        // it from every model's spend would invent a number that climbs while
        // the real cap sits still.
        let scoped = self.anchors.get("weeklyScoped").map(|a| (a.scope.clone(), self.resolve_window("weeklyScoped", events, now))).filter(|(_, r)| r.source == "official");
        json!({
            "fiveHour": window_json("fiveHour", &five),
            "sevenDay": window_json("sevenDay", &seven),
            "weeklyScoped": scoped.map(|(scope, r)| { let mut v = window_json("weeklyScoped", &r); v["scope"] = json!(scope); v }),
            "spend": { "fiveHour": local::spend_since(events, now - FIVE_HOURS_MS), "sevenDay": local::spend_since(events, now - SEVEN_DAYS_MS) },
            "quotaRate": { "fiveHour": self.calibration.get("fiveHour"), "sevenDay": self.calibration.get("sevenDay") },
            "budget": { "fiveHour": self.budget("fiveHour", &five, events, now), "sevenDay": self.budget("sevenDay", &seven, events, now) },
            "cost": {
                "fiveHour": local::spend_since(events, now - FIVE_HOURS_MS),
                "sevenDay": local::spend_since(events, now - SEVEN_DAYS_MS),
                "lifetime": null,
                "official": self.official_spend,
                "plan": plan,
                "pricing": price_meta("anthropic"),
            },
            "tokensPerMinute": local::rate_per_minute(events, now, RATE_WINDOW_MS),
            "calibrated": self.calibration.contains_key("fiveHour") || self.calibration.contains_key("sevenDay"),
            "official": {
                "lastAttempt": self.last_official_attempt,
                "nextPollAt": official.0,
                "backingOff": official.1,
                "reason": official.2,
            },
            "localEvents": events.len(),
        })
    }
}

fn anchor_json(a: &Anchor) -> Value {
    json!({ "at": a.at, "usedPercent": a.used_percent, "resetsAt": a.resets_at, "scope": a.scope })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::official::Parsed;

    const NOW: i64 = 1_793_936_229_404;
    const HOUR: i64 = 3600 * 1000;

    fn ev(ts: i64, cost: f64, tokens: u64) -> Event {
        Event { ts, cost, output: 10, tokens, model: "claude-opus-5-5".into() }
    }
    fn ok(at: i64, five: Option<(f64, i64)>, seven: Option<(f64, i64)>) -> Fetch {
        let r = |p: Option<(f64, i64)>| p.map(|(used, resets)| Reading { used_percent: used, resets_at: Some(resets), severity: None, scope: None });
        Fetch { status: "ok", reason: None, retry_at: None, at, parsed: Parsed { five_hour: r(five), seven_day: r(seven), weekly_scoped: None, spend: None } }
    }
    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("speedo-store-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("state.json")
    }

    #[test]
    fn a_window_starts_at_its_reset_minus_its_span_and_walks_forward() {
        assert_eq!(window_start(Some(NOW + HOUR), FIVE_HOURS_MS, NOW), NOW + HOUR - FIVE_HOURS_MS);
        assert_eq!(window_start(None, FIVE_HOURS_MS, NOW), NOW - FIVE_HOURS_MS);
        // reset two cycles ago: the window in force opened at the last boundary
        assert_eq!(window_start(Some(NOW - 2 * FIVE_HOURS_MS - HOUR), FIVE_HOURS_MS, NOW), NOW - HOUR);
    }

    #[test]
    fn an_official_reading_anchors_the_window_and_learns_both_rates() {
        let mut s = UsageStore::new(Some(tmp("learn")), None);
        // a week of history that fully covers the window: $30 and 3.6M tokens
        // ($0.18 an hour, so even the 5-hour window clears the $0.50 calibration floor)
        let mut events: Vec<Event> = (0..7 * 24).map(|h| ev(NOW - h as i64 * HOUR - 1000, 30.0 / 168.0, 3_600_000 / 168)).collect();
        events.sort_by_key(|e| e.ts);
        let fetch = ok(NOW, Some((40.0, NOW + HOUR)), Some((10.0, NOW + 2 * 24 * HOUR)));
        assert!(s.ingest_official(&fetch, &events, NOW));
        assert_eq!(s.anchors["sevenDay"].used_percent, 10.0);
        // percent per dollar for the week: 10% over the window's spend
        let week_cost: f64 = events.iter().filter(|e| e.ts >= NOW - 5 * 24 * HOUR).map(|e| e.cost).sum();
        assert!((s.calibration["sevenDay"] - 10.0 / week_cost).abs() < 1e-9);
        // tokens per percent, only where the window is covered and past 8%
        let week_tokens: u64 = events.iter().filter(|e| e.ts >= NOW - 5 * 24 * HOUR).map(|e| e.tokens).sum();
        assert!((s.token_calibration["sevenDay"] - week_tokens as f64 / 10.0).abs() < 1e-6);
        // the 5-hour window at 40%: calibrated in dollars too
        assert!(s.calibration.contains_key("fiveHour"));

        let r = s.resolve_window("sevenDay", &events, NOW);
        assert_eq!((r.percent, r.source), (Some(10.0), "official"));
        let b = s.budget("sevenDay", &r, &events, NOW);
        assert_eq!(b["confidence"], "measured");
        assert!((b["remainingTokens"].as_f64().unwrap() - week_tokens as f64 * 9.0).abs() < 1.0);

        // spend after the anchor projects the percentage forward
        let mut later = events.clone();
        later.push(ev(NOW + 60_000, 1.0, 1000));
        let r = s.resolve_window("sevenDay", &later, NOW + 120_000);
        assert_eq!(r.source, "hybrid");
        assert!(r.percent.unwrap() > 10.0);

        // the state round-trips through state.json
        let again = UsageStore::new(Some(tmp("learn")), None);
        assert_eq!(again.anchors["sevenDay"], s.anchors["sevenDay"]);
        assert_eq!(again.token_calibration["sevenDay"], s.token_calibration["sevenDay"]);
    }

    #[test]
    fn a_stale_or_rolled_anchor_gives_way_to_a_local_estimate_or_to_honesty() {
        let mut s = UsageStore::new(None, None);
        let events = vec![ev(NOW - HOUR, 2.0, 1000), ev(NOW - 30_000, 1.0, 500)];
        s.ingest_official(&ok(NOW - 2 * HOUR, Some((50.0, NOW - 60_000)), None), &events, NOW);
        // rolled over a minute ago: no anchor, no calibration (spend was under the floor at ingest) -> unknown
        let r = s.resolve_window("fiveHour", &events, NOW);
        assert_eq!((r.percent, r.source), (None, "uncalibrated"));
        assert_eq!(r.resets_at, Some(NOW - 60_000 + FIVE_HOURS_MS));
        // with a rate, the local projection counts spend since the new window opened
        s.calibration.insert("fiveHour".into(), 10.0);
        let r = s.resolve_window("fiveHour", &events, NOW);
        assert_eq!((r.percent, r.source), (Some(10.0), "local"));
        // an anchor older than 90 minutes is stale even if its window is live
        s.ingest_official(&ok(NOW - 2 * HOUR, Some((30.0, NOW + HOUR)), None), &events, NOW);
        assert_eq!(s.resolve_window("fiveHour", &events, NOW).source, "local");
    }

    #[test]
    fn the_session_file_anchors_the_week_unless_it_is_stale_junk_or_older_than_the_anchor() {
        let dir = std::env::temp_dir().join(format!("speedo-sf-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("reading.json");
        let write = |at: i64, left: f64| std::fs::write(&file, json!({ "v": 1, "at": at, "source": "claude-code", "sevenDay": { "percentLeft": left, "resetsAt": NOW + 10 * HOUR }, "fiveHour": { "percentLeft": null } }).to_string()).unwrap();
        let mut s = UsageStore::new(None, Some(file.clone()));
        write(NOW, 87.0);
        assert!(s.ingest_session_file(&[], NOW));
        assert_eq!(s.anchors["sevenDay"].used_percent, 13.0);
        assert!(!s.anchors.contains_key("fiveHour"));
        assert!(!s.ingest_session_file(&[], NOW), "unchanged file is read once");
        std::fs::write(&file, "junk").unwrap();
        s.session_file_mtime = None;
        assert!(!s.ingest_session_file(&[], NOW));
        write(NOW - SESSION_FILE_MAX_AGE_MS - 1, 50.0);
        s.session_file_mtime = None;
        assert!(!s.ingest_session_file(&[], NOW));
        assert_eq!(s.anchors["sevenDay"].used_percent, 13.0);
        s.anchors.insert("sevenDay".into(), Anchor { at: NOW + 5000, used_percent: 50.0, resets_at: None, scope: None });
        write(NOW, 87.0);
        s.session_file_mtime = None;
        assert!(!s.ingest_session_file(&[], NOW));
        assert_eq!(s.anchors["sevenDay"].used_percent, 50.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
