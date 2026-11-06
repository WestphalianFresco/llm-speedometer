//! OpenAI's Codex CLI. Its rollouts under `~/.codex/sessions/YYYY/MM/DD/`
//! carry per-turn token counts AND a `rate_limits` block with the percentage
//! used, the window and the reset time, so there is nothing to poll: the
//! weekly tank comes straight out of the transcript. ChatGPT plans report
//! one weekly window and no 5-hour one, so that gauge reads N/A.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::local::parse_iso_ms;
use crate::paths::{codex_auth, codex_home, codex_sessions};
use crate::pricing::{cost_of_tokens, price_meta};

const RATE_WINDOW_MS: i64 = 10 * 60 * 1000;
const SEVEN_DAYS_MS: i64 = 7 * 24 * 3600 * 1000;
/// A rollout not touched in this long is idle: Codex writes no liveness record.
const BUSY_WINDOW_MS: i64 = 90 * 1000;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Event {
    pub ts: i64,
    pub input: f64,
    pub output: f64,
    pub cached_input: f64,
    pub cache_write: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Meta {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub cli_version: Option<String>,
    pub started_at: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct Parsed {
    pub events: Vec<Event>,
    pub meta: Option<Meta>,
    pub rate_limits: Option<Value>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// input, output, cached input, cache write: cumulative for the session
    pub totals: (f64, f64, f64, f64),
}

/// `gpt-6.1-sol` → `GPT-6.1 Sol`: the version stays hyphenated to GPT the
/// way OpenAI writes it.
pub fn pretty_model(id: &str) -> String {
    match id {
        "gpt-5.6-sol" => return "GPT-5.6 Sol".into(),
        "gpt-5.3-codex" => return "GPT-5.3-Codex".into(),
        _ => {}
    }
    let cap = |p: &str| { let mut c = p.chars(); c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default() };
    let mut parts = id.split('-');
    let head = parts.next().unwrap_or(id);
    let rest: Vec<&str> = parts.collect();
    if head.eq_ignore_ascii_case("gpt") && !rest.is_empty() {
        let mut out = vec![format!("GPT-{}", rest[0])];
        out.extend(rest[1..].iter().map(|p| cap(p)));
        return out.join(" ");
    }
    std::iter::once(head).chain(rest).map(cap).collect::<Vec<_>>().join(" ")
}

pub fn pretty_plan(plan: Option<&str>) -> Option<String> {
    let p = plan?;
    let mut c = p.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str())
}

/// Every rollout transcript under the sessions tree.
pub fn rollout_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut guard = 0;
    while let Some(dir) = stack.pop() {
        guard += 1;
        if guard > 5000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                    out.push(path);
                }
            }
        }
    }
    out
}

/// Rollouts top out in the hundreds of KB, so a whole re-read on change is
/// cheaper than tracking offsets across interleaved record types.
pub fn parse_rollout(text: &str) -> Parsed {
    let mut out = Parsed::default();
    let n = |v: Option<&Value>| v.and_then(|v| v.as_f64()).unwrap_or(0.0);
    for line in text.lines() {
        if line.is_empty() || !line.contains("\"type\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        let Some(payload) = record.get("payload").filter(|p| p.is_object()) else { continue };
        let text_of = |v: Option<&Value>| v.and_then(|v| v.as_str()).map(str::to_string);
        match record.get("type").and_then(|v| v.as_str()) {
            Some("session_meta") => {
                out.meta = Some(Meta {
                    session_id: text_of(payload.get("session_id")).or_else(|| text_of(payload.get("id"))),
                    cwd: text_of(payload.get("cwd")),
                    cli_version: text_of(payload.get("cli_version")),
                    started_at: payload.get("timestamp").or(record.get("timestamp")).and_then(|v| v.as_str()).and_then(parse_iso_ms),
                });
                continue;
            }
            Some("turn_context") => {
                if let Some(m) = text_of(payload.get("model")) {
                    out.model = Some(m);
                }
                if let Some(e) = text_of(payload.get("collaboration_mode").and_then(|c| c.get("settings")).and_then(|s| s.get("reasoning_effort"))) {
                    out.effort = Some(e);
                }
                continue;
            }
            _ => {}
        }
        // token_count events carry the running total and the delta for the
        // turn that just finished; the delta is what a rate needs.
        if let Some(info) = payload.get("info") {
            if let Some(last) = info.get("last_token_usage") {
                if let Some(ts) = record.get("timestamp").and_then(|v| v.as_str()).and_then(parse_iso_ms) {
                    out.events.push(Event {
                        ts,
                        input: n(last.get("input_tokens")),
                        output: n(last.get("output_tokens")),
                        cached_input: n(last.get("cached_input_tokens")),
                        cache_write: n(last.get("cache_write_input_tokens")),
                    });
                }
            }
            if let Some(t) = info.get("total_token_usage") {
                out.totals = (n(t.get("input_tokens")), n(t.get("output_tokens")), n(t.get("cached_input_tokens")), n(t.get("cache_write_input_tokens")));
            }
        }
        if let Some(rl) = payload.get("rate_limits").filter(|v| v.is_object()) {
            out.rate_limits = Some(rl.clone());
        }
    }
    out
}

struct Rollout {
    file: PathBuf,
    mtime_ms: i64,
    parsed: Parsed,
}

#[derive(Default)]
pub struct CodexStore {
    cache: HashMap<PathBuf, (Option<std::time::SystemTime>, u64, Parsed)>,
    rollouts: Vec<Rollout>,
    last_scan_at: i64,
}

#[derive(Debug, Default, PartialEq)]
pub struct Tally {
    pub tokens: f64,
    pub cost: f64,
    pub turns: u64,
    pub covered: f64,
}

fn mtime_ms(t: Option<std::time::SystemTime>) -> i64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl CodexStore {
    pub fn refresh_local(&mut self, now: i64) {
        let Some(root) = codex_sessions() else { return };
        let mut seen = std::collections::HashSet::new();
        let mut rollouts = Vec::new();
        for file in rollout_files(&root) {
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            let (mtime, size) = (meta.modified().ok(), meta.len());
            seen.insert(file.clone());
            let parsed = match self.cache.get(&file) {
                Some((m, s, p)) if *m == mtime && *s == size => p.clone(),
                _ => {
                    let p = std::fs::read(&file).map(|b| parse_rollout(&String::from_utf8_lossy(&b))).unwrap_or_default();
                    self.cache.insert(file.clone(), (mtime, size, p.clone()));
                    p
                }
            };
            rollouts.push(Rollout { file, mtime_ms: mtime_ms(mtime), parsed });
        }
        self.cache.retain(|k, _| seen.contains(k));
        rollouts.sort_by_key(|r| r.mtime_ms);
        self.rollouts = rollouts;
        self.last_scan_at = now;
    }

    fn newest(&self) -> Option<&Rollout> {
        self.rollouts.last()
    }

    pub fn rate_per_minute(&self, now: i64) -> f64 {
        let since = now - RATE_WINDOW_MS;
        // `+ 0.0`: an empty f64 sum is -0.0, which the page would print as "-0"
        let output: f64 = self.rollouts.iter().flat_map(|r| r.parsed.events.iter()).filter(|e| e.ts >= since && e.ts <= now).map(|e| e.output).sum::<f64>() + 0.0;
        output / (RATE_WINDOW_MS as f64 / 60_000.0)
    }

    /// Tokens, turns and dollars inside a window. Each rollout's model prices
    /// its own turns: a session on a mini model is not costed at the flagship
    /// rate. Coverage is bounded by how far back the rollouts go, since Codex
    /// keeps them indefinitely.
    pub fn window_tally(&self, from: i64, to: i64) -> Tally {
        let mut t = Tally::default();
        let mut oldest: Option<i64> = None;
        for r in &self.rollouts {
            let model = r.parsed.model.as_deref().unwrap_or("");
            for e in &r.parsed.events {
                oldest = Some(oldest.map_or(e.ts, |o| o.min(e.ts)));
                if e.ts < from || e.ts > to {
                    continue;
                }
                // the odometer's definition: fed plus produced, cached reads out
                t.tokens += e.input + e.cache_write + e.output;
                t.cost += cost_of_tokens(e.input, e.output, e.cached_input, e.cache_write, model, "openai");
                t.turns += 1;
            }
        }
        let span = (to - from).max(1) as f64;
        let horizon = oldest.map(|o| from.max(o.min(to))).unwrap_or(to);
        t.covered = ((to - horizon) as f64 / span).clamp(0.0, 1.0);
        t
    }

    /// A window in tokens, mirroring the Anthropic store's budget so one page
    /// fits both: the same 8% and coverage floors.
    pub fn budget_for(&self, window: &Value, span_ms: i64, now: i64) -> Value {
        let resets_at = window.get("resetsAt").and_then(|v| v.as_i64());
        let start = resets_at.map(|r| (r - span_ms).min(now)).unwrap_or(now - span_ms);
        let tally = self.window_tally(start, now);
        let percent = window.get("percent").and_then(|v| v.as_f64());
        let mut out = json!({ "windowStart": start, "resetsAt": resets_at, "usedTokens": tally.tokens, "usedCost": tally.cost, "turns": tally.turns, "covered": tally.covered,
                              "capacityTokens": null, "remainingTokens": null, "confidence": "unknown" });
        if let Some(p) = percent.filter(|p| *p >= 8.0) {
            if tally.covered >= 0.98 && tally.tokens > 0.0 {
                let capacity = tally.tokens / (p / 100.0);
                out["capacityTokens"] = json!(capacity);
                out["remainingTokens"] = json!((capacity * (100.0 - p) / 100.0).max(0.0));
                out["confidence"] = json!("measured");
            }
        }
        out
    }

    pub fn odometer(&self) -> Value {
        let sum = |p: &Parsed| p.totals.0 + p.totals.3 + p.totals.1;
        let total: f64 = self.rollouts.iter().map(|r| sum(&r.parsed)).sum::<f64>() + 0.0;
        let turns: usize = self.rollouts.iter().map(|r| r.parsed.events.len()).sum();
        let newest = self.newest();
        json!({
            "total": total, "turns": turns, "files": self.rollouts.len(),
            "trip": newest.map(|r| sum(&r.parsed)).unwrap_or(0.0),
            "tripTurns": newest.map(|r| r.parsed.events.len()).unwrap_or(0),
            "tripSessionId": newest.and_then(|r| r.parsed.meta.as_ref()).and_then(|m| m.session_id.clone()),
        })
    }

    pub fn live_sessions(&self, now: i64) -> Vec<Value> {
        self.rollouts.iter().rev().map(|r| {
            let meta = r.parsed.meta.clone().unwrap_or_default();
            let id = meta.session_id.clone().unwrap_or_else(|| r.file.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string());
            // Codex has no session naming: the folder being worked in stands in
            let name = match meta.cwd.as_deref().and_then(|c| Path::new(c).file_name()).and_then(|n| n.to_str()) {
                Some(dir) => format!("{dir}-{}", id.chars().take(4).collect::<String>()),
                None => id.chars().take(8).collect(),
            };
            json!({
                "pid": null, "sessionId": meta.session_id, "name": name, "cwd": meta.cwd,
                "status": if now - r.mtime_ms < BUSY_WINDOW_MS { "busy" } else { "idle" },
                "kind": "cli", "updatedAt": r.mtime_ms, "startedAt": meta.started_at, "model": r.parsed.model,
            })
        }).collect()
    }

    /// The payload's vendor half: windows, budgets, cost, session, odometer.
    pub fn read(&self, now: i64) -> Value {
        let parsed = self.newest().map(|r| &r.parsed);
        let limits = parsed.and_then(|p| p.rate_limits.as_ref());
        let primary = limits.and_then(|l| l.get("primary")).filter(|v| v.is_object());
        let secondary = limits.and_then(|l| l.get("secondary")).filter(|v| v.is_object());
        let minutes = |w: Option<&Value>| w.and_then(|w| w.get("window_minutes")).and_then(|v| v.as_f64());
        // ChatGPT plans report one weekly window; there is no 5-hour one
        let weekly = primary.filter(|p| minutes(Some(p)).unwrap_or(0.0) >= 1440.0);
        let short = secondary.or(primary.filter(|p| minutes(Some(p)).unwrap_or(0.0) < 1440.0));
        let window_from = |w: Option<&Value>, label: &str| match w {
            None => json!({ "percent": null, "source": "unsupported", "confidence": "unknown", "resetsAt": null, "anchorAt": null, "label": label }),
            Some(w) => json!({
                "percent": w.get("used_percent").and_then(|v| v.as_f64()).unwrap_or(0.0).clamp(0.0, 100.0),
                "source": "official", "confidence": "exact", "anchorAt": now,
                "resetsAt": w.get("resets_at").and_then(|v| v.as_f64()).map(|s| (s * 1000.0) as i64),
                "label": label,
            }),
        };
        let five = window_from(short, "5-hour");
        let seven = window_from(weekly, "This week");
        let short_span = minutes(short).map(|m| (m * 60_000.0) as i64).unwrap_or(5 * 3600 * 1000);
        let weekly_span = minutes(weekly).map(|m| (m * 60_000.0) as i64).unwrap_or(SEVEN_DAYS_MS);
        let five_tally = self.window_tally(now - short_span, now);
        let seven_tally = self.window_tally(now - weekly_span, now);
        let lifetime = self.window_tally(0, now);
        let plan = pretty_plan(limits.and_then(|l| l.get("plan_type")).and_then(|v| v.as_str()));
        let odo = self.odometer();
        let model = parsed.and_then(|p| p.model.clone());
        json!({
            "at": now,
            "vendorId": "openai",
            "fiveHour": five,
            "sevenDay": seven,
            "weeklyScoped": null,
            "spend": { "fiveHour": five_tally.cost, "sevenDay": seven_tally.cost },
            "quotaRate": { "fiveHour": null, "sevenDay": null },
            "budget": { "fiveHour": self.budget_for(&five, short_span, now), "sevenDay": self.budget_for(&seven, weekly_span, now), "lifetime": { "usedTokens": odo["total"], "turns": odo["turns"] } },
            // a flat subscription: these dollars are a scale for the work, not an invoice
            "cost": { "fiveHour": five_tally.cost, "sevenDay": seven_tally.cost, "lifetime": lifetime.cost, "official": null, "plan": plan, "pricing": price_meta("openai") },
            "tokensPerMinute": self.rate_per_minute(now),
            "calibrated": primary.is_some(),
            "official": { "lastAttempt": { "at": self.last_scan_at, "status": if limits.is_some() { "ok" } else { "no_data" } }, "nextPollAt": 0, "backingOff": false,
                          "reason": if limits.is_some() { Value::Null } else { json!("no rate_limits recorded yet") } },
            "localEvents": odo["turns"],
            "account": { "email": null, "org": null },
            "session": {
                "version": parsed.and_then(|p| p.meta.as_ref()).and_then(|m| m.cli_version.clone()),
                "company": "OpenAI",
                "modelId": model,
                "model": model.as_deref().map(pretty_model),
                "effort": parsed.and_then(|p| p.effort.clone()),
                "plan": plan,
                "cwd": parsed.and_then(|p| p.meta.as_ref()).and_then(|m| m.cwd.clone()),
                "sessionName": null,
            },
            // Codex's model lives in config.toml, which this dashboard does not edit
            "configuredModel": model.as_deref().map(pretty_model),
            "configuredModelValue": model,
            "configuredModelFamily": null,
            "modelOptions": [],
            "liveSessions": self.live_sessions(now),
            "odometer": odo,
        })
    }
}

/// Is Codex here, signed in, and has it written anything to read?
pub fn detect() -> Value {
    let Some(home) = codex_home().filter(|h| h.exists()) else {
        return json!({ "present": false, "usable": false, "dataAvailable": false, "account": null,
            "note": "Codex CLI not found on this device. Sign in to ChatGPT, install Codex, then run `codex` once — usage appears here straight after, with no restart needed." });
    };
    let _ = home;
    let signed_in = codex_auth().map(|a| a.exists()).unwrap_or(false);
    let has_data = codex_sessions().map(|s| !rollout_files(&s).is_empty()).unwrap_or(false);
    if !has_data {
        return json!({ "present": signed_in, "usable": false, "dataAvailable": false, "account": null,
            "note": "Codex CLI is installed but has not been run on this machine yet, so it has written no usage data. Run `codex` once and it will appear." });
    }
    json!({ "present": signed_in, "usable": true, "dataAvailable": true, "account": null,
        "note": "Codex rollouts found. Output rate, odometer and the weekly tank are available. ChatGPT plans report only a weekly window, so TANK / 5H reads N/A." })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_936_229_404;

    fn rollout(events: &[(&str, f64, f64, f64)], rate_limits: Option<&str>) -> String {
        let mut lines = vec![
            r#"{"timestamp":"2026-11-05T12:00:00.000Z","type":"session_meta","payload":{"id":"abc-123","cwd":"/Users/x/proj","cli_version":"0.9.1","timestamp":"2026-11-05T12:00:00.000Z"}}"#.to_string(),
            r#"{"timestamp":"2026-11-05T12:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5.3-codex","collaboration_mode":{"settings":{"reasoning_effort":"high"}}}}"#.to_string(),
        ];
        let mut total = (0.0, 0.0, 0.0);
        for (ts, input, output, cached) in events {
            total = (total.0 + input, total.1 + output, total.2 + cached);
            let rl = rate_limits.map(|r| format!(r#","rate_limits":{r}"#)).unwrap_or_default();
            lines.push(format!(r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{},"cached_input_tokens":{},"cache_write_input_tokens":0,"output_tokens":{}}},"last_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"cache_write_input_tokens":0,"output_tokens":{output}}}}}{rl}}}}}"#, total.0, total.2, total.1));
        }
        lines.join("\n")
    }

    const LIMITS: &str = r#"{"limit_id":"codex","primary":{"used_percent":57.0,"window_minutes":10080,"resets_at":1794300000},"secondary":null,"plan_type":"plus"}"#;

    #[test]
    fn a_rollout_yields_its_turns_totals_meta_and_limits() {
        let p = parse_rollout(&rollout(&[("2026-11-05T12:01:00.000Z", 1000.0, 50.0, 400.0), ("2026-11-05T12:05:00.000Z", 2000.0, 100.0, 1500.0)], Some(LIMITS)));
        assert_eq!(p.events.len(), 2);
        assert_eq!(p.events[1], Event { ts: parse_iso_ms("2026-11-05T12:05:00.000Z").unwrap(), input: 2000.0, output: 100.0, cached_input: 1500.0, cache_write: 0.0 });
        assert_eq!(p.totals, (3000.0, 150.0, 1900.0, 0.0));
        assert_eq!(p.model.as_deref(), Some("gpt-5.3-codex"));
        assert_eq!(p.effort.as_deref(), Some("high"));
        let meta = p.meta.unwrap();
        assert_eq!((meta.session_id.as_deref(), meta.cwd.as_deref(), meta.cli_version.as_deref()), (Some("abc-123"), Some("/Users/x/proj"), Some("0.9.1")));
        assert_eq!(p.rate_limits.unwrap()["primary"]["used_percent"], 57.0);
        assert!(parse_rollout("not a rollout\n{\"type\":\"x\"}").events.is_empty());
    }

    #[test]
    fn the_store_reads_a_weekly_tank_and_no_five_hour_one() {
        let dir = std::env::temp_dir().join(format!("speedo-codex-{}", std::process::id()));
        let day = dir.join("sessions").join("2026").join("11").join("05");
        std::fs::create_dir_all(&day).unwrap();
        unsafe { std::env::set_var("CODEX_HOME", &dir) };
        std::fs::write(day.join("rollout-2026-11-05T12-00-00-abc.jsonl"), rollout(&[("2026-11-05T12:01:00.000Z", 1000.0, 50.0, 400.0)], Some(LIMITS))).unwrap();
        let mut s = CodexStore::default();
        s.refresh_local(NOW);
        let r = s.read(NOW);
        assert_eq!(r["sevenDay"]["percent"], 57.0);
        assert_eq!(r["sevenDay"]["resetsAt"], 1794300000000i64);
        assert_eq!(r["fiveHour"]["source"], "unsupported");
        assert_eq!(r["odometer"]["total"], 1050.0);
        assert_eq!(r["odometer"]["tripSessionId"], "abc-123");
        assert_eq!(r["session"]["model"], "GPT-5.3-Codex");
        assert_eq!(r["session"]["plan"], "Plus");
        assert_eq!(r["liveSessions"][0]["name"], "proj-abc-");
        // one turn of 1000 in / 50 out, cached 400, on gpt-5.3-codex: (600 + 400*0.1) * 1.75 + 50 * 14, per million
        let expected = ((600.0 + 40.0) * 1.75 + 50.0 * 14.0) / 1e6;
        assert!((r["cost"]["sevenDay"].as_f64().unwrap() - expected).abs() < 1e-12);
        // the week is only hours deep, so no capacity is claimed
        assert_eq!(r["budget"]["sevenDay"]["confidence"], "unknown");
        assert!(detect()["usable"].as_bool().unwrap());
        unsafe { std::env::remove_var("CODEX_HOME") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Reads this machine's own rollouts; run with `-- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_codex_on_this_machine() {
        let mut s = CodexStore::default();
        s.refresh_local(crate::now_ms());
        let r = s.read(crate::now_ms());
        println!("files={} odo={} week={}%/{} resets={} rate={:.0} model={} plan={} sessions={}",
            r["odometer"]["files"], r["odometer"]["total"], r["sevenDay"]["percent"], r["sevenDay"]["source"], r["sevenDay"]["resetsAt"],
            r["tokensPerMinute"].as_f64().unwrap_or(0.0), r["session"]["model"], r["session"]["plan"], r["liveSessions"].as_array().map(|l| l.len()).unwrap_or(0));
        println!("detect={}", detect());
    }

    #[test]
    fn model_and_plan_names() {
        assert_eq!(pretty_model("gpt-6.1-sol"), "GPT-6.1 Sol");
        assert_eq!(pretty_model("gpt-5.3-codex"), "GPT-5.3-Codex");
        assert_eq!(pretty_model("o3-mini"), "O3 Mini");
        assert_eq!(pretty_plan(Some("plus")).as_deref(), Some("Plus"));
        assert_eq!(pretty_plan(None), None);
    }
}
