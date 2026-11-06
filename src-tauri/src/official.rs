//! Anthropic's usage endpoint, which throttles far harder than a normal API
//! route (anthropics/claude-code#31021, #31637). Everything here touches it
//! as rarely as possible and retreats hard the moment it complains.
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

use crate::credentials::read_credentials;

pub const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
pub const MIN_INTERVAL_MS: i64 = 5 * 60 * 1000;
pub const BASE_INTERVAL_MS: i64 = 15 * 60 * 1000;
const BACKOFF_LADDER_MS: [i64; 4] = [15 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000];

const USED_FIELDS: [&str; 4] = ["utilization", "used_percent", "percent_used", "percentage"];
const REMAINING_FIELDS: [&str; 2] = ["remaining", "remaining_percent"];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reading {
    pub used_percent: f64,
    pub resets_at: Option<i64>,
    pub severity: Option<String>,
    pub scope: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Spend {
    pub used_usd: f64,
    pub limit_usd: Option<f64>,
    pub currency: String,
    pub enabled: bool,
    pub percent: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct Parsed {
    pub five_hour: Option<Reading>,
    pub seven_day: Option<Reading>,
    pub weekly_scoped: Option<Reading>,
    pub spend: Option<Spend>,
}

#[derive(Clone, Debug, Default)]
pub struct Fetch {
    /// `ok`, `cooldown`, `rate_limited` or `error`.
    pub status: &'static str,
    pub reason: Option<String>,
    pub retry_at: Option<i64>,
    pub at: i64,
    pub parsed: Parsed,
}

fn numeric(v: Option<&Value>) -> Option<f64> {
    v.and_then(|v| v.as_f64()).filter(|n| n.is_finite())
}

fn levels(raw: Option<&Value>) -> Vec<f64> {
    let Some(raw) = raw else { return vec![] };
    USED_FIELDS.iter().chain(REMAINING_FIELDS.iter()).filter_map(|f| numeric(raw.get(*f))).filter(|n| *n >= 0.0).collect()
}

/// Levels arrive as 0..1 or 0..100 and no single field can tell which: the
/// scale is settled once from every number in the payload. Anything above 1
/// can only be a percentage; failing that a true fraction is the 0..1 shape;
/// nothing but 0s and 1s reads as percentages.
fn scale_for(raws: &[Option<&Value>]) -> f64 {
    let all: Vec<f64> = raws.iter().flat_map(|r| levels(*r)).collect();
    if all.iter().any(|v| *v > 1.0) {
        1.0
    } else if all.iter().any(|v| *v > 0.0 && *v < 1.0) {
        100.0
    } else {
        1.0
    }
}

fn pick_percent(raw: &Value, fields: &[&str], scale: f64) -> Option<f64> {
    fields.iter().find_map(|f| numeric(raw.get(*f)).filter(|n| *n >= 0.0)).map(|n| n * scale)
}

fn to_epoch_ms(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()).map(|f| if f > 1e12 { f as i64 } else { (f * 1000.0) as i64 }),
        Some(Value::String(s)) => crate::local::parse_iso_ms(s),
        _ => None,
    }
}

fn window_re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}
static FIVE: OnceLock<Regex> = OnceLock::new();
static SEVEN: OnceLock<Regex> = OnceLock::new();

/// A window pulled out of the payload without depending on its nesting.
fn find_window<'a>(payload: &'a Value, re: &Regex, depth: u32) -> Option<&'a Value> {
    let map = payload.as_object()?;
    if depth > 5 {
        return None;
    }
    for (key, value) in map {
        if re.is_match(key) {
            if value.is_object() {
                return Some(value);
            }
        }
    }
    map.values().filter(|v| v.is_object()).find_map(|v| find_window(v, re, depth + 1))
}

fn read_window(raw: Option<&Value>, scale: f64) -> Option<Reading> {
    let raw = raw?;
    let remaining = pick_percent(raw, &REMAINING_FIELDS, scale);
    let used = pick_percent(raw, &USED_FIELDS, scale).or(remaining.map(|r| 100.0 - r))?;
    let resets_at = ["resets_at", "reset_at", "resetsAt", "reset", "expires_at"].iter().find_map(|k| to_epoch_ms(raw.get(*k)));
    Some(Reading { used_percent: used.clamp(0.0, 100.0), resets_at, severity: None, scope: None })
}

fn scope_label(scope: Option<&Value>) -> Option<String> {
    let scope = scope?.as_object()?;
    let model = scope.get("model").and_then(|m| m.get("display_name").or(m.get("id"))).and_then(|v| v.as_str());
    let surface = scope.get("surface").and_then(|s| s.as_str().map(str::to_string).or_else(|| s.get("display_name").and_then(|v| v.as_str()).map(str::to_string)));
    let parts: Vec<String> = model.map(str::to_string).into_iter().chain(surface).collect();
    if parts.is_empty() { None } else { Some(parts.join(" · ")) }
}

/// The `limits` array, the shape `/usage` itself renders: plain 0..100
/// percentages, plus the per-model weekly cap the legacy keys never carry.
/// Several scoped caps can be in flight; only the tightest gets a gauge.
pub fn read_limits(payload: &Value) -> Option<Parsed> {
    let list = payload.get("limits")?.as_array()?;
    let mut out = Parsed::default();
    for entry in list.iter().filter(|e| e.is_object()) {
        let kind = entry.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
        let slot = match kind.as_str() {
            "session" | "five_hour" => &mut out.five_hour,
            "weekly_all" | "seven_day" => &mut out.seven_day,
            "weekly_scoped" => &mut out.weekly_scoped,
            _ => continue,
        };
        let Some(percent) = numeric(entry.get("percent")).filter(|p| *p >= 0.0) else { continue };
        let reading = Reading {
            used_percent: percent.clamp(0.0, 100.0),
            resets_at: to_epoch_ms(entry.get("resets_at")),
            severity: entry.get("severity").and_then(|v| v.as_str()).map(str::to_string),
            scope: scope_label(entry.get("scope")),
        };
        if slot.as_ref().map(|s| reading.used_percent > s.used_percent).unwrap_or(true) {
            *slot = Some(reading);
        }
    }
    if out.five_hour.is_none() && out.seven_day.is_none() && out.weekly_scoped.is_none() { None } else { Some(out) }
}

/// Money actually owed: credits burned past the plan, in minor units.
pub fn read_spend(payload: &Value) -> Option<Spend> {
    if let Some(spend) = payload.get("spend") {
        if let Some(amount) = numeric(spend.get("used").and_then(|u| u.get("amount_minor"))) {
            let divisor = 10f64.powf(numeric(spend.get("used").and_then(|u| u.get("exponent"))).unwrap_or(2.0));
            return Some(Spend {
                used_usd: amount / divisor,
                limit_usd: numeric(spend.get("limit").and_then(|l| l.get("amount_minor"))).map(|l| l / divisor),
                currency: spend.get("used").and_then(|u| u.get("currency")).and_then(|v| v.as_str()).unwrap_or("USD").to_string(),
                enabled: spend.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
                percent: numeric(spend.get("percent")),
            });
        }
    }
    let extra = payload.get("extra_usage")?;
    let used = numeric(extra.get("used_credits"))?;
    let divisor = 10f64.powf(numeric(extra.get("decimal_places")).unwrap_or(2.0));
    Some(Spend {
        used_usd: used / divisor,
        limit_usd: numeric(extra.get("monthly_limit")).map(|l| l / divisor),
        currency: extra.get("currency").and_then(|v| v.as_str()).unwrap_or("USD").to_string(),
        enabled: extra.get("is_enabled").and_then(|v| v.as_bool()).unwrap_or(true),
        percent: numeric(extra.get("utilization")),
    })
}

/// Both windows are pulled out before either is converted so the pair agrees
/// on one scale; the limits array wins where it answers.
pub fn parse_payload(payload: &Value) -> Parsed {
    let raw_five = find_window(payload, window_re(&FIVE, r"(?i)^(five_?hour|5h|five_?hour_?limit)$"), 0);
    let raw_seven = find_window(payload, window_re(&SEVEN, r"(?i)^(seven_?day|7d|weekly|week|seven_?day_?limit)$"), 0);
    let scale = scale_for(&[raw_five, raw_seven]);
    let limits = read_limits(payload).unwrap_or_default();
    Parsed {
        five_hour: limits.five_hour.or_else(|| read_window(raw_five, scale)),
        seven_day: limits.seven_day.or_else(|| read_window(raw_seven, scale)),
        weekly_scoped: limits.weekly_scoped,
        spend: read_spend(payload),
    }
}

pub struct OfficialProvider {
    backoff_index: i32, // -1 == healthy
    pub next_allowed_at: i64,
    pub last_error: Option<String>,
}

impl Default for OfficialProvider {
    fn default() -> Self {
        Self { backoff_index: -1, next_allowed_at: 0, last_error: None }
    }
}

impl OfficialProvider {
    pub fn backing_off(&self) -> bool {
        self.backoff_index >= 0
    }

    fn current_interval_ms(&self) -> i64 {
        if self.backoff_index < 0 {
            BASE_INTERVAL_MS
        } else {
            BACKOFF_LADDER_MS[(self.backoff_index as usize).min(BACKOFF_LADDER_MS.len() - 1)]
        }
    }

    fn succeed(&mut self, now: i64) {
        self.backoff_index = -1;
        self.last_error = None;
        self.next_allowed_at = now + BASE_INTERVAL_MS;
    }

    fn throttle(&mut self, now: i64, reason: &str, retry_after_ms: i64) {
        self.backoff_index = (self.backoff_index + 1).min(BACKOFF_LADDER_MS.len() as i32 - 1);
        self.next_allowed_at = now + retry_after_ms.max(self.current_interval_ms());
        self.last_error = Some(reason.to_string());
    }

    fn error(&mut self, now: i64, reason: &str, retry_after_ms: i64) -> Fetch {
        self.throttle(now, reason, retry_after_ms);
        Fetch { status: "error", reason: Some(reason.to_string()), retry_at: Some(self.next_allowed_at), at: now, ..Default::default() }
    }

    /// `force` skips the comfortable interval but still respects the hard
    /// floor, so impatient clicking cannot dig a 429 hole.
    pub fn fetch(&mut self, now: i64, force: bool) -> Fetch {
        if !force && now < self.next_allowed_at {
            return Fetch { status: "cooldown", reason: self.last_error.clone(), retry_at: Some(self.next_allowed_at), at: now, ..Default::default() };
        }
        if force && now < self.next_allowed_at - (self.current_interval_ms() - MIN_INTERVAL_MS) {
            return Fetch { status: "cooldown", reason: Some("min_interval".into()), retry_at: Some(self.next_allowed_at), at: now, ..Default::default() };
        }
        let creds = match read_credentials() {
            Ok(Some(c)) => c,
            Ok(None) => return self.error(now, "no_credentials", 60 * 60_000),
            Err(reason) => return self.error(now, reason, 60 * 60_000),
        };
        if creds.expires_at.map(|e| e < now).unwrap_or(false) {
            // Claude Code refreshes the token on its next run; nothing to do here.
            return self.error(now, "token_expired", 30 * 60_000);
        }
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
        let response = agent
            .get(ENDPOINT)
            .set("authorization", &format!("Bearer {}", creds.token))
            .set("anthropic-beta", "oauth-2025-04-20")
            .set("accept", "application/json")
            .set("user-agent", "llm-speedometer/0.4 (local desktop widget)")
            .call();
        let response = match response {
            Ok(r) => r,
            Err(ureq::Error::Status(429, r)) => {
                let retry_after = r.header("retry-after").and_then(|v| v.parse::<f64>().ok()).map(|s| (s * 1000.0) as i64).unwrap_or(0);
                self.throttle(now, "rate_limited", retry_after);
                return Fetch { status: "rate_limited", reason: Some("rate_limited".into()), retry_at: Some(self.next_allowed_at), at: now, ..Default::default() };
            }
            Err(ureq::Error::Status(401 | 403, _)) => return self.error(now, "unauthorized", 60 * 60_000),
            Err(ureq::Error::Status(code, _)) => return self.error(now, &format!("http_{code}"), 0),
            Err(ureq::Error::Transport(t)) => {
                let reason = if t.kind() == ureq::ErrorKind::Io && t.message().map(|m| m.contains("timed out")).unwrap_or(false) { "timeout" } else { "network_error" };
                return self.error(now, reason, 0);
            }
        };
        let Ok(payload) = response.into_json::<Value>() else { return self.error(now, "bad_payload", 0) };
        let parsed = parse_payload(&payload);
        if parsed.five_hour.is_none() && parsed.seven_day.is_none() {
            // Answered, but in a shape not understood: a soft failure, so the
            // local estimator stays in charge instead of showing 0%. The body
            // is deliberately not returned anywhere.
            return self.error(now, "unrecognized_schema", 60 * 60_000);
        }
        self.succeed(now);
        Fetch { status: "ok", reason: None, retry_at: None, at: now, parsed }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_limits_array_wins_and_the_tightest_scoped_cap_is_kept() {
        let p = json!({
            "five_hour": { "utilization": 0.4 },
            "seven_day": { "utilization": 0.1 },
            "limits": [
                { "kind": "session", "percent": 78, "resets_at": "2026-11-05T09:09:00Z" },
                { "kind": "weekly_all", "percent": 9, "resets_at": 1793977200 },
                { "kind": "weekly_scoped", "percent": 14, "scope": { "model": { "display_name": "Opus" } } },
                { "kind": "weekly_scoped", "percent": 3, "scope": { "model": { "id": "haiku" } } },
                { "kind": "mystery", "percent": 99 }
            ]
        });
        let r = parse_payload(&p);
        assert_eq!(r.five_hour.as_ref().unwrap().used_percent, 78.0);
        assert_eq!(r.five_hour.as_ref().unwrap().resets_at, crate::local::parse_iso_ms("2026-11-05T09:09:00Z"));
        assert_eq!(r.seven_day.as_ref().unwrap().resets_at, Some(1793977200000));
        let scoped = r.weekly_scoped.unwrap();
        assert_eq!((scoped.used_percent, scoped.scope.as_deref()), (14.0, Some("Opus")));
    }

    #[test]
    fn legacy_windows_settle_one_scale_between_them() {
        // 1 beside 26 can only be percentages: the 5-hour tank is at 1%, not empty
        let p = json!({ "five_hour": { "utilization": 1 }, "seven_day": { "utilization": 26 } });
        let r = parse_payload(&p);
        assert_eq!(r.five_hour.unwrap().used_percent, 1.0);
        assert_eq!(r.seven_day.unwrap().used_percent, 26.0);
        // fractions
        let p = json!({ "usage": { "five_hour": { "utilization": 0.4 }, "seven_day": { "remaining": 0.9 } } });
        let r = parse_payload(&p);
        assert_eq!(r.five_hour.unwrap().used_percent, 40.0);
        assert!((r.seven_day.unwrap().used_percent - 10.0).abs() < 1e-9);
        assert!(parse_payload(&json!({ "hello": 1 })).seven_day.is_none());
    }

    #[test]
    fn spend_is_read_in_minor_units_from_either_shape() {
        let s = read_spend(&json!({ "spend": { "used": { "amount_minor": 1250, "exponent": 2, "currency": "USD" }, "limit": { "amount_minor": 5000 }, "percent": 25 } })).unwrap();
        assert_eq!((s.used_usd, s.limit_usd, s.percent), (12.5, Some(50.0), Some(25.0)));
        let s = read_spend(&json!({ "extra_usage": { "used_credits": 300, "decimal_places": 2, "monthly_limit": 1000, "is_enabled": false } })).unwrap();
        assert_eq!((s.used_usd, s.limit_usd, s.enabled), (3.0, Some(10.0), false));
        assert!(read_spend(&json!({})).is_none());
    }

    #[test]
    fn the_backoff_ladder_climbs_and_a_forced_poll_respects_the_floor() {
        let mut o = OfficialProvider::default();
        let now = 1_000_000;
        o.throttle(now, "rate_limited", 0);
        assert_eq!(o.next_allowed_at, now + 15 * 60_000);
        o.throttle(now, "rate_limited", 0);
        assert_eq!(o.next_allowed_at, now + 30 * 60_000);
        o.throttle(now, "rate_limited", 4 * 60 * 60_000);
        assert_eq!(o.next_allowed_at, now + 4 * 60 * 60_000);
        assert_eq!(o.fetch(now, false).status, "cooldown");
        assert_eq!(o.fetch(now, true).reason.as_deref(), Some("min_interval"));
        o.succeed(now);
        assert!(!o.backing_off());
        assert_eq!(o.next_allowed_at, now + BASE_INTERVAL_MS);
    }
}
