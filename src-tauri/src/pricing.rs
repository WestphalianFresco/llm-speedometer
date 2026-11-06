//! One price list for every vendor, USD per million tokens. On a subscription
//! dollars are only a weighting unit for the quota gauges; without one they
//! are the bill, so every vendor is costed the same way.
//!
//! `~/.llm-speedometer/pricing.json` overrides a price without a release:
//! `{ "<vendor>": { "<regex>": { "input": 2, "output": 10, "cacheRead": 0.1 } } }`.
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub exact: bool,
}

const CACHE_WRITE_5M: f64 = 1.25;
const CACHE_WRITE_1H: f64 = 2.0;
const CACHE_READ: f64 = 0.1;

struct Vendor {
    as_of: &'static str,
    source: &'static str,
    models: &'static [(&'static str, f64, f64, Option<f64>)],
    fallback: (f64, f64),
}

const ANTHROPIC: Vendor = Vendor {
    as_of: "2026-09-30",
    source: "https://claude.com/pricing",
    models: &[
        (r"^claude-(fable|mythos)-5-1", 10.0, 50.0, Some(0.025)),
        (r"^claude-(fable|mythos)-5", 10.0, 50.0, None),
        (r"^claude-opus-5-5", 4.0, 20.0, Some(0.05)),
        (r"^claude-opus-", 5.0, 25.0, None),
        (r"^claude-sonnet-5", 2.0, 10.0, None),
        (r"^claude-sonnet-", 3.0, 15.0, None),
        (r"^claude-haiku-", 1.0, 5.0, None),
    ],
    fallback: (5.0, 25.0),
};
const OPENAI: Vendor = Vendor {
    as_of: "2026-09-30",
    source: "https://openai.com/api/pricing/",
    models: &[
        (r"^gpt-6-astra", 10.0, 50.0, None),
        (r"^gpt-6\.1-sol", 2.0, 10.0, Some(0.05)),
        (r"^gpt-6-sol", 2.0, 10.0, None),
        (r"^gpt-6-luna", 0.1, 0.5, None),
        (r"^gpt-5\.6-sol", 4.0, 20.0, None),
        (r"^gpt-5\.6-terra", 2.0, 12.0, None),
        (r"^gpt-5\.6-luna", 0.2, 1.2, None),
        (r"^gpt-5\.5", 5.0, 30.0, None),
        (r"^gpt-5\.4-nano", 0.2, 1.25, None),
        (r"^gpt-5\.4-mini", 0.75, 4.5, None),
        (r"^gpt-5\.4", 2.5, 15.0, None),
        (r"^gpt-5\.3-codex", 1.75, 14.0, None),
        (r"^gpt-5.*mini", 0.25, 2.0, None),
        (r"^gpt-5", 1.25, 10.0, None),
        (r"^o3", 2.0, 8.0, None),
        (r"^gpt-4\.1.*mini", 0.4, 1.6, None),
        (r"^gpt-4\.1", 2.0, 8.0, None),
    ],
    fallback: (1.25, 10.0),
};
const GOOGLE: Vendor = Vendor {
    as_of: "2026-09-30",
    source: "https://ai.google.dev/pricing",
    models: &[
        (r"^gemini-3\.[678]-flash", 0.75, 3.75, None),
        (r"^gemini-3\.5-flash-lite", 0.3, 2.5, None),
        (r"^gemini-3\.5-flash", 1.5, 9.0, None),
        (r"^gemini-3\.1-flash-lite", 0.25, 1.5, None),
        (r"^gemini-3\.1-pro", 2.0, 12.0, None),
        (r"^gemini-2\.5-flash-lite", 0.1, 0.4, None),
        (r"^gemini-.*flash", 0.3, 2.5, None),
        (r"^gemini-.*pro", 1.25, 10.0, None),
    ],
    fallback: (1.25, 10.0),
};

fn vendor(id: &str) -> &'static Vendor {
    match id {
        "openai" => &OPENAI,
        "google" => &GOOGLE,
        _ => &ANTHROPIC,
    }
}

type Rules = Vec<(Regex, Price)>;

fn compiled(id: &str) -> &'static Rules {
    static ANTH: OnceLock<Rules> = OnceLock::new();
    static OAI: OnceLock<Rules> = OnceLock::new();
    static GOOG: OnceLock<Rules> = OnceLock::new();
    let (cell, v) = match id {
        "openai" => (&OAI, &OPENAI),
        "google" => (&GOOG, &GOOGLE),
        _ => (&ANTH, &ANTHROPIC),
    };
    cell.get_or_init(|| {
        v.models
            .iter()
            .map(|(p, i, o, c)| (Regex::new(p).expect("static regex"), Price { input: *i, output: *o, cache_read: *c, exact: true }))
            .collect()
    })
}

pub fn override_file() -> Option<std::path::PathBuf> {
    crate::paths::speedometer_dir().map(|d| d.join("pricing.json"))
}

const OVERRIDE_TTL: Duration = Duration::from_secs(60);

/// Parsed from the override file: nothing in it can execute, the keys become
/// patterns and the values finite positive numbers, so a hand-edited file can
/// do no more than misprice a model.
pub fn parse_overrides(raw: &Value) -> HashMap<String, Rules> {
    let mut out = HashMap::new();
    let Some(vendors) = raw.as_object() else { return out };
    for (id, models) in vendors {
        if !["anthropic", "openai", "google"].contains(&id.as_str()) {
            continue;
        }
        let Some(models) = models.as_object() else { continue };
        let mut list = Vec::new();
        for (pattern, price) in models {
            let (Some(input), Some(output)) = (price.get("input").and_then(|v| v.as_f64()), price.get("output").and_then(|v| v.as_f64())) else { continue };
            if !(input.is_finite() && output.is_finite() && input > 0.0 && output > 0.0) {
                continue;
            }
            let Ok(re) = Regex::new(&format!("(?i){pattern}")) else { continue };
            let cache_read = price.get("cacheRead").and_then(|v| v.as_f64()).filter(|c| *c > 0.0 && *c <= 1.0);
            list.push((re, Price { input, output, cache_read, exact: true }));
        }
        if !list.is_empty() {
            out.insert(id.clone(), list);
        }
    }
    out
}

fn overrides() -> &'static Mutex<(Option<Instant>, HashMap<String, Rules>)> {
    static CACHE: OnceLock<Mutex<(Option<Instant>, HashMap<String, Rules>)>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new((None, HashMap::new())));
    if let Ok(mut c) = cache.lock() {
        if c.0.map(|at| at.elapsed() > OVERRIDE_TTL).unwrap_or(true) {
            let raw = override_file().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok());
            c.1 = raw.map(|r| parse_overrides(&r)).unwrap_or_default();
            c.0 = Some(Instant::now());
        }
    }
    cache
}

pub fn price_for(vendor_id: &str, model: &str) -> Price {
    let id = model.to_ascii_lowercase();
    if let Ok(c) = overrides().lock() {
        if let Some(rules) = c.1.get(vendor_id) {
            if let Some((_, p)) = rules.iter().find(|(re, _)| re.is_match(&id)) {
                return *p;
            }
        }
    }
    if !id.is_empty() {
        if let Some((_, p)) = compiled(vendor_id).iter().find(|(re, _)| re.is_match(&id)) {
            return *p;
        }
    }
    let (input, output) = vendor(vendor_id).fallback;
    Price { input, output, cache_read: None, exact: false }
}

/// Cost in USD of one usage block in Anthropic's transcript shape.
pub fn cost_of(usage: &Value, model: &str, vendor_id: &str) -> f64 {
    let price = price_for(vendor_id, model);
    let n = |v: Option<&Value>| v.and_then(|v| v.as_f64()).unwrap_or(0.0);
    let creation = usage.get("cache_creation");
    let write_5m = n(creation.and_then(|c| c.get("ephemeral_5m_input_tokens")));
    let write_1h = n(creation.and_then(|c| c.get("ephemeral_1h_input_tokens")));
    let write_flat = (n(usage.get("cache_creation_input_tokens")) - write_5m - write_1h).max(0.0);
    let input_units = n(usage.get("input_tokens"))
        + write_5m * CACHE_WRITE_5M
        + write_1h * CACHE_WRITE_1H
        + write_flat * CACHE_WRITE_5M
        + n(usage.get("cache_read_input_tokens")) * price.cache_read.unwrap_or(CACHE_READ);
    (input_units * price.input + n(usage.get("output_tokens")) * price.output) / 1e6
}

/// Cost from plain counts, where `input` already contains the cached part —
/// (for the Codex rollouts, when that provider is ported)
/// how Codex and the OpenAI API report it. Adding the cached count on top
/// would bill those tokens twice.
#[allow(dead_code)]
pub fn cost_of_tokens(input: f64, output: f64, cached_input: f64, cache_write: f64, model: &str, vendor_id: &str) -> f64 {
    let price = price_for(vendor_id, model);
    let uncached = (input - cached_input).max(0.0);
    let input_units = uncached + cached_input * price.cache_read.unwrap_or(CACHE_READ) + cache_write * CACHE_WRITE_5M;
    (input_units * price.input + output * price.output) / 1e6
}

/// What the UI shows when it explains where a dollar figure came from.
pub fn price_meta(vendor_id: &str) -> Value {
    let v = vendor(vendor_id);
    let overridden = overrides().lock().map(|c| c.1.contains_key(vendor_id)).unwrap_or(false);
    json!({
        "asOf": v.as_of,
        "source": v.source,
        "overridden": overridden,
        "overrideFile": override_file().map(|p| p.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_match_the_table_and_fall_back_honestly() {
        assert_eq!(price_for("anthropic", "claude-opus-5-5"), Price { input: 4.0, output: 20.0, cache_read: Some(0.05), exact: true });
        assert_eq!(price_for("anthropic", "claude-opus-4-8").input, 5.0);
        assert!(!price_for("anthropic", "claude-unknown-9").exact);
        assert_eq!(price_for("openai", "gpt-5.4-mini").output, 4.5);
        assert_eq!(price_for("google", "gemini-3.5-flash").input, 1.5);
    }

    #[test]
    fn a_turn_is_costed_with_its_cache_tiers() {
        // 2 input, 30890 written for 1h, 28950 read, 281 out, on Opus 5.5
        let usage = json!({ "input_tokens": 2, "cache_creation_input_tokens": 30890, "cache_read_input_tokens": 28950, "output_tokens": 281,
                            "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 30890 } });
        let expected = ((2.0 + 30890.0 * 2.0 + 28950.0 * 0.05) * 4.0 + 281.0 * 20.0) / 1e6;
        assert!((cost_of(&usage, "claude-opus-5-5", "anthropic") - expected).abs() < 1e-12);
        // flat cache writes (no tier breakdown) are priced at the 5-minute rate
        let flat = json!({ "input_tokens": 0, "cache_creation_input_tokens": 1000, "output_tokens": 0 });
        assert!((cost_of(&flat, "claude-haiku-4-5", "anthropic") - 1000.0 * 1.25 * 1.0 / 1e6).abs() < 1e-12);
        // Codex-style counts: cached tokens are inside `input`, never added on top
        assert!((cost_of_tokens(411_000.0, 0.0, 366_000.0, 0.0, "gpt-5", "openai") - (45_000.0 + 36_600.0) * 1.25 / 1e6).abs() < 1e-9);
    }

    #[test]
    fn overrides_take_only_sane_entries() {
        let raw = json!({ "anthropic": { "^claude-sonnet-5": { "input": 2, "output": 10 }, "^bad": { "input": -1, "output": 3 }, "[": { "input": 1, "output": 1 } },
                          "nobody": { "x": { "input": 1, "output": 1 } } });
        let o = parse_overrides(&raw);
        assert_eq!(o.get("anthropic").map(|l| l.len()), Some(1));
        assert!(!o.contains_key("nobody"));
    }
}
