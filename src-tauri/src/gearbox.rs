//! The H-pattern shifter's catalogue, and the one real mutation this app
//! makes: writing `model` into Claude Code's settings.json. The page never
//! sends a model name; it sends a provider id and a gear number, and the
//! only value that can reach the file is the `apply` the catalogue carries.
use serde_json::{json, Value};
use std::sync::OnceLock;

use crate::paths::claude_settings;

pub const MODEL_OPTIONS: [(&str, &str); 4] =
    [("fable", "Fable 5.1"), ("opus", "Opus 5.5"), ("sonnet", "Sonnet 5.5"), ("haiku", "Haiku 4.5")];

pub fn model_options() -> Value {
    MODEL_OPTIONS.iter().map(|(v, l)| json!({ "value": v, "label": l })).collect()
}

/// `opus[1m]` and friends: the suffix picks a context window, not a model.
pub fn label_for(value: &str) -> String {
    let base = value.split('[').next().unwrap_or(value);
    MODEL_OPTIONS.iter().find(|(v, _)| *v == value || *v == base).map(|(_, l)| l.to_string()).unwrap_or_else(|| value.to_string())
}

pub fn model_family(value: &str) -> Option<String> {
    let f: String = value.to_ascii_lowercase().split('[').next().unwrap_or("").trim_start_matches("claude-").chars().filter(|c| c.is_ascii_lowercase()).collect();
    if f.is_empty() { None } else { Some(f) }
}

pub fn providers() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| json!([
        { "id": "anthropic", "emoji": "✴️", "name": "Anthropic", "product": "Claude Code", "accent": "#D97757", "configurable": true,
          "note": "Engaging a gear writes settings.json. Claude Code reads it when a session starts, so a running window keeps its current model.",
          "gears": [
            { "gear": 1, "label": "Fable 5.1", "detail": "most capable", "apply": "fable" },
            { "gear": 2, "label": "Opus 5.5", "detail": "flagship", "apply": "opus" },
            { "gear": 3, "label": "Sonnet 5.5", "detail": "balanced", "apply": "sonnet" },
            { "gear": 4, "label": "Haiku 4.5", "detail": "fast", "apply": "haiku" } ] },
        { "id": "openai", "emoji": "🌀", "name": "OpenAI", "product": "Codex CLI", "accent": "#10A37F", "configurable": false,
          "note": "Codex keeps its model in config.toml. This dashboard does not edit TOML, so a gear here records your choice without changing Codex.",
          "gears": [
            { "gear": 1, "label": "GPT-6 Astra", "detail": "flagship" }, { "gear": 2, "label": "GPT-6.1 Sol", "detail": "near-flagship, cheaper" },
            { "gear": 3, "label": "GPT-5.6 Sol", "detail": "previous" }, { "gear": 4, "label": "GPT-5.3-Codex", "detail": "coding" },
            { "gear": 5, "label": "GPT-6 Luna", "detail": "fast" } ] },
        { "id": "google", "emoji": "✨", "name": "Google", "product": "Gemini CLI", "accent": "#4285F4", "configurable": false,
          "note": "No reader is implemented for Gemini CLI yet, so this gate records a choice only.",
          "gears": [
            { "gear": 1, "label": "Gemini 3.1 Pro", "detail": "flagship, preview" }, { "gear": 2, "label": "Gemini 3.8 Flash", "detail": "fast" },
            { "gear": 3, "label": "Gemini 3.5 Flash-Lite", "detail": "lightest" }, { "gear": 4, "label": "Gemini 2.5 Pro", "detail": "previous" } ] },
        { "id": "xai", "emoji": "✖️", "name": "xAI", "product": "Grok", "accent": "#8E8E93", "configurable": false,
          "note": "Display only — no local CLI is read for xAI.",
          "gears": [ { "gear": 1, "label": "Grok 4.7", "detail": "flagship" }, { "gear": 2, "label": "Grok 4.6", "detail": "previous" }, { "gear": 3, "label": "Grok 4.3", "detail": "lighter" } ] },
        { "id": "meta", "emoji": "♾️", "name": "Meta", "product": "Muse", "accent": "#0866FF", "configurable": false,
          "note": "Display only — no local CLI is read for Meta.",
          "gears": [ { "gear": 1, "label": "Muse Spark 1.3", "detail": "flagship" }, { "gear": 2, "label": "Muse Glimmer 30B", "detail": "open weights, local" }, { "gear": 3, "label": "Llama 4 Maverick", "detail": "previous, open" } ] },
        { "id": "mistral", "emoji": "🌬️", "name": "Mistral", "product": "Le Chat", "accent": "#FA520F", "configurable": false,
          "note": "Display only — no local CLI is read for Mistral.",
          "gears": [ { "gear": 1, "label": "Mistral Medium 3.5", "detail": "flagship" }, { "gear": 2, "label": "Mistral Large 3", "detail": "largest, open" }, { "gear": 3, "label": "Mistral Small 4", "detail": "fast" }, { "gear": 4, "label": "Codestral", "detail": "code" } ] },
        { "id": "deepseek", "emoji": "🐋", "name": "DeepSeek", "product": "DeepSeek", "accent": "#4D6BFE", "configurable": false,
          "note": "Display only — no local CLI is read for DeepSeek.",
          "gears": [ { "gear": 1, "label": "DeepSeek-V4-Pro", "detail": "flagship" }, { "gear": 2, "label": "DeepSeek-V4.1-Flash", "detail": "fast" } ] },
        { "id": "cohere", "emoji": "🔗", "name": "Cohere", "product": "Command", "accent": "#39594D", "configurable": false,
          "note": "Display only — no local CLI is read for Cohere.",
          "gears": [ { "gear": 1, "label": "Command A+", "detail": "flagship" }, { "gear": 2, "label": "Command A", "detail": "previous" }, { "gear": 3, "label": "Command R7B", "detail": "small, fast" } ] }
    ]))
}

pub struct Found {
    pub configurable: bool,
    pub label: String,
    pub apply: Option<String>,
}

pub fn find_gear(provider_id: &str, gear: i64) -> Option<Found> {
    let provider = providers().as_array()?.iter().find(|p| p["id"] == provider_id)?;
    let g = provider["gears"].as_array()?.iter().find(|g| g["gear"].as_i64() == Some(gear))?;
    Some(Found {
        configurable: provider["configurable"].as_bool().unwrap_or(false),
        label: g["label"].as_str().unwrap_or("").to_string(),
        apply: g.get("apply").and_then(|v| v.as_str()).map(str::to_string),
    })
}

/// Write `model` into settings.json: refused for a value outside the list,
/// a missing or unparseable file (rewriting one would destroy content), and
/// done atomically with a one-time backup and a 0600 temp file, since that
/// file can carry API keys and hook commands.
pub fn write_model(value: &str) -> Value {
    if !MODEL_OPTIONS.iter().any(|(v, _)| *v == value) {
        return json!({ "ok": false, "reason": "unknown_model" });
    }
    let Some(target) = claude_settings() else { return json!({ "ok": false, "reason": "no_settings_file" }) };
    let raw = match std::fs::read_to_string(&target) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return json!({ "ok": false, "reason": "no_settings_file" }),
        Err(_) => return json!({ "ok": false, "reason": "unreadable" }),
    };
    let mut settings: Value = match serde_json::from_str(&raw) {
        Ok(v @ Value::Object(_)) => v,
        _ => return json!({ "ok": false, "reason": "malformed_settings" }),
    };
    if settings.get("model").and_then(|v| v.as_str()) == Some(value) {
        return json!({ "ok": true, "model": value });
    }
    let backup = target.with_file_name(format!("{}.speedometer.bak", target.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json")));
    if !backup.exists() {
        let _ = std::fs::write(&backup, &raw); // a missing backup must not block the change
    }
    settings["model"] = json!(value);
    let tmp = target.with_file_name(format!("{}.tmp-{}", target.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json"), std::process::id()));
    let text = serde_json::to_string_pretty(&settings).unwrap_or_default() + "\n";
    let written = write_private(&tmp, &text).and_then(|_| std::fs::rename(&tmp, &target));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return json!({ "ok": false, "reason": "write_failed" });
    }
    json!({ "ok": true, "model": value })
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(text.as_bytes())
}
#[cfg(not(unix))]
fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    std::fs::write(path, text)
}

/// Engage a gear: resolve it against the catalogue, write the model where
/// the provider is configurable, and advance the shifter's state only once
/// the file actually changed. Reverse re-engages `previous`.
pub fn engage(gearbox: &mut Value, provider_id: &str, gear: &Value) -> Value {
    let (provider_id, gear_number) = if gear.as_str() == Some("R") {
        let Some(back) = gearbox.get("previous").filter(|p| p.is_object()).cloned() else { return json!({ "ok": false, "reason": "nothing_to_reverse_to" }) };
        (back["providerId"].as_str().unwrap_or("").to_string(), back["gear"].as_i64().unwrap_or(0))
    } else {
        (provider_id.to_string(), gear.as_i64().or_else(|| gear.as_str().and_then(|s| s.parse().ok())).unwrap_or(0))
    };
    let Some(found) = find_gear(&provider_id, gear_number) else { return json!({ "ok": false, "reason": "unknown_gear" }) };
    let applied = json!({ "providerId": provider_id, "gear": gear_number, "label": found.label });
    let mut wrote = false;
    if found.configurable {
        if let Some(apply) = &found.apply {
            let write = write_model(apply);
            if write["ok"] != true {
                return json!({ "ok": false, "reason": write["reason"], "gear": applied });
            }
            wrote = true;
        }
    }
    let changed = gearbox["providerId"] != applied["providerId"] || gearbox["gear"] != applied["gear"];
    let previous = if changed && !gearbox["gear"].is_null() {
        json!({ "providerId": gearbox["providerId"], "gear": gearbox["gear"], "label": gearbox["label"] })
    } else {
        gearbox["previous"].clone()
    };
    *gearbox = json!({ "providerId": applied["providerId"], "gear": applied["gear"], "label": applied["label"], "previous": previous });
    // `applied: false` means recorded, but nothing on disk changed
    json!({ "ok": true, "gearbox": gearbox.clone(), "applied": wrote, "label": found.label })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_families() {
        assert_eq!(label_for("opus"), "Opus 5.5");
        assert_eq!(label_for("opus[1m]"), "Opus 5.5");
        assert_eq!(label_for("claude-mystery"), "claude-mystery");
        assert_eq!(model_family("claude-opus-5-5[1m]").as_deref(), Some("opus"));
        assert_eq!(model_family("[1m]"), None);
        assert!(find_gear("anthropic", 2).unwrap().apply.as_deref() == Some("opus"));
        assert!(find_gear("openai", 1).unwrap().apply.is_none());
        assert!(find_gear("anthropic", 9).is_none());
    }

    #[test]
    fn the_catalogue_only_applies_values_write_model_accepts() {
        for p in providers().as_array().unwrap() {
            for g in p["gears"].as_array().unwrap() {
                if let Some(apply) = g.get("apply").and_then(|v| v.as_str()) {
                    assert!(p["configurable"] == true, "{} is not configurable", p["id"]);
                    assert!(MODEL_OPTIONS.iter().any(|(v, _)| *v == apply), "{apply} would be refused");
                }
            }
        }
    }

    #[test]
    fn a_gear_on_a_display_only_make_is_recorded_and_reverse_goes_back() {
        let mut gb = crate::ui::default_gearbox();
        let r = engage(&mut gb, "openai", &json!(2));
        assert_eq!((r["ok"].as_bool(), r["applied"].as_bool(), r["label"].as_str()), (Some(true), Some(false), Some("GPT-6.1 Sol")));
        assert_eq!(gb["gear"], 2);
        assert!(gb["previous"].is_null(), "nothing was engaged before");
        engage(&mut gb, "openai", &json!(5));
        assert_eq!(gb["previous"]["gear"], 2);
        let r = engage(&mut gb, "whatever", &json!("R"));
        assert_eq!((r["ok"].as_bool(), gb["gear"].as_i64()), (Some(true), Some(2)));
        assert_eq!(engage(&mut gb, "openai", &json!(42))["reason"], "unknown_gear");
        let mut fresh = crate::ui::default_gearbox();
        assert_eq!(engage(&mut fresh, "openai", &json!("R"))["reason"], "nothing_to_reverse_to");
    }

    #[test]
    fn write_model_keeps_the_file_intact_and_backs_it_up_once() {
        let dir = std::env::temp_dir().join(format!("speedo-settings-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // CLAUDE_CONFIG_DIR is authoritative for where settings.json lives
        unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", &dir) };
        let target = dir.join("settings.json");
        assert_eq!(write_model("opus")["reason"], "no_settings_file");
        std::fs::write(&target, "{\"model\": \"haiku\", \"hooks\": {\"keep\": true}}").unwrap();
        assert_eq!(write_model("gpt-9")["reason"], "unknown_model");
        assert_eq!(write_model("opus")["ok"], true);
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!((after["model"].as_str(), after["hooks"]["keep"].as_bool()), (Some("opus"), Some(true)));
        assert!(std::fs::read_to_string(dir.join("settings.json.speedometer.bak")).unwrap().contains("haiku"));
        assert_eq!(write_model("opus")["ok"], true, "already set is fine");
        std::fs::write(&target, "{ not json").unwrap();
        assert_eq!(write_model("sonnet")["reason"], "malformed_settings");
        assert!(std::fs::read_to_string(&target).unwrap().contains("not json"), "a file that cannot be parsed is never rewritten");
        unsafe { std::env::remove_var("CLAUDE_CONFIG_DIR") };
        let _ = std::fs::remove_dir_all(&dir);
    }
}
