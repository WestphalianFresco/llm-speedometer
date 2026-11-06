//! How this widget is set up on this machine: the window's place and size,
//! the settings panel's preferences, the gearbox's position. One `ui.json`,
//! the same one the Electron build kept, so a switch loses nothing.
use serde_json::{json, Value};
use std::path::PathBuf;

pub const NORMAL_SIZE: (f64, f64) = (470.0, 432.0);
pub const MINI_SIZE: (f64, f64) = (278.0, 54.0);
pub const MIN_SCALE: f64 = 0.6;
pub const MAX_SCALE: f64 = 2.5;
pub const ASPECT: f64 = NORMAL_SIZE.0 / NORMAL_SIZE.1;

pub fn default_settings() -> Value {
    json!({
        "theme": "system",      // system | light | dark
        "opacity": 1,           // 0.55 .. 1
        "alwaysOnTop": true,
        "openAtLogin": false,
        "sound": true,
        "volume": 0.8,          // 0 .. 1
        "showSessions": true,
        "minimizeToTray": true,
        "streamDeck": true,
        "gearboxHintSeen": false,
    })
}

pub fn default_gearbox() -> Value {
    json!({ "providerId": "anthropic", "gear": null, "label": null, "previous": null })
}

/// One setting, made the shape its key demands, or `None` for a key that is
/// not a setting at all.
pub fn coerce_setting(key: &str, value: &Value) -> Option<Value> {
    let number = |v: &Value| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok())).filter(|n| n.is_finite());
    Some(match key {
        "theme" => json!(match value.as_str() { Some(t @ ("system" | "light" | "dark")) => t, _ => "system" }),
        // 0 is a legitimate volume, and a bad opacity clamps to the floor
        "opacity" => json!(number(value).map(|n| n.clamp(0.55, 1.0)).unwrap_or(1.0)),
        "volume" => json!(number(value).map(|n| n.clamp(0.0, 1.0)).unwrap_or(0.0)),
        "alwaysOnTop" | "openAtLogin" | "sound" | "showSessions" | "minimizeToTray" | "streamDeck" | "gearboxHintSeen" => {
            json!(match value { Value::Bool(b) => *b, Value::Null => false, Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0, Value::String(s) => !s.is_empty(), _ => true })
        }
        _ => return None,
    })
}

/// A saved width is only kept if it is a number inside the scale range.
pub fn coerce_width(value: Option<f64>) -> Option<f64> {
    let n = value.filter(|n| n.is_finite() && *n > 0.0)?;
    Some(n.clamp(NORMAL_SIZE.0 * MIN_SCALE, NORMAL_SIZE.0 * MAX_SCALE).round())
}

#[derive(Clone, Debug)]
pub struct UiState {
    pub mini: bool,
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// The expanded window's width; its height follows from ASPECT. None
    /// means never resized.
    pub width: Option<f64>,
    pub unlocked: bool,
    pub vendor: Option<String>,
    pub settings: Value,
    pub gearbox: Value,
}

impl Default for UiState {
    fn default() -> Self {
        Self { mini: false, x: None, y: None, width: None, unlocked: false, vendor: None, settings: default_settings(), gearbox: default_gearbox() }
    }
}

impl UiState {
    pub fn load(path: Option<&PathBuf>) -> Self {
        let mut state = Self::default();
        let Some(saved) = path.and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return state };
        state.x = saved.get("x").and_then(|v| v.as_f64());
        state.y = saved.get("y").and_then(|v| v.as_f64());
        state.width = coerce_width(saved.get("width").and_then(|v| v.as_f64()));
        state.vendor = saved.get("vendor").and_then(|v| v.as_str()).map(str::to_string);
        // A settings block saved by an older build is missing whatever has
        // been added since: fill the gaps rather than trusting its shape.
        if let Some(block) = saved.get("settings").and_then(|v| v.as_object()) {
            for (key, value) in block {
                if let Some(c) = coerce_setting(key, value) {
                    state.settings[key] = c;
                }
            }
        }
        state.gearbox = coerce_gearbox(saved.get("gearbox"));
        // Every launch opens on the landing screen, expanded: the key ceremony
        // is the front door, and the pill has no room for it.
        state.unlocked = false;
        state.mini = false;
        state
    }

    pub fn save(&self, path: Option<&PathBuf>) {
        let Some(path) = path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let text = serde_json::to_string_pretty(&json!({
            "mini": self.mini, "x": self.x, "y": self.y, "width": self.width,
            "unlocked": self.unlocked, "vendor": self.vendor,
            "settings": self.settings, "gearbox": self.gearbox,
        })).unwrap_or_default();
        // never fail over a cache write
        let _ = std::fs::write(path, text);
    }

    pub fn flag(&self, key: &str) -> bool {
        self.settings.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }
}

/// Only the fields the shifter owns, each the type it should be.
pub fn coerce_gearbox(saved: Option<&Value>) -> Value {
    let mut out = default_gearbox();
    let Some(s) = saved.filter(|v| v.is_object()) else { return out };
    if let Some(p) = s.get("providerId").and_then(|v| v.as_str()) {
        out["providerId"] = json!(p);
    }
    let gear_of = |v: Option<&Value>| v.and_then(|g| g.as_i64()).filter(|g| *g > 0);
    out["gear"] = json!(gear_of(s.get("gear")));
    out["label"] = json!(s.get("label").and_then(|v| v.as_str()));
    if let Some(prev) = s.get("previous").filter(|v| v.is_object()) {
        if let (Some(p), Some(g)) = (prev.get("providerId").and_then(|v| v.as_str()), gear_of(prev.get("gear"))) {
            out["previous"] = json!({ "providerId": p, "gear": g, "label": prev.get("label").and_then(|v| v.as_str()) });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_are_coerced_and_unknown_keys_refused() {
        assert_eq!(coerce_setting("theme", &json!("dark")), Some(json!("dark")));
        assert_eq!(coerce_setting("theme", &json!("neon")), Some(json!("system")));
        assert_eq!(coerce_setting("opacity", &json!(0.1)), Some(json!(0.55)));
        assert_eq!(coerce_setting("opacity", &json!("nope")), Some(json!(1.0)));
        assert_eq!(coerce_setting("volume", &json!(0)), Some(json!(0.0)));
        assert_eq!(coerce_setting("alwaysOnTop", &json!(0)), Some(json!(false)));
        assert_eq!(coerce_setting("streamDeck", &json!("yes")), Some(json!(true)));
        assert_eq!(coerce_setting("favouriteColour", &json!("red")), None);
        assert_eq!(coerce_width(Some(10.0)), Some(282.0));
        assert_eq!(coerce_width(Some(5000.0)), Some(1175.0));
        assert_eq!(coerce_width(Some(-1.0)), None);
    }

    #[test]
    fn ui_state_round_trips_and_always_opens_locked_and_expanded() {
        let dir = std::env::temp_dir().join(format!("speedo-ui-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("ui.json");
        let mut s = UiState { mini: true, x: Some(10.0), y: Some(20.0), width: Some(600.0), unlocked: true, vendor: Some("anthropic".into()), ..Default::default() };
        s.settings["theme"] = json!("dark");
        s.gearbox = json!({ "providerId": "anthropic", "gear": 2, "label": "Opus 5.5", "previous": { "providerId": "anthropic", "gear": 4, "label": "Haiku 4.5" }, "junk": 1 });
        s.save(Some(&path));
        let back = UiState::load(Some(&path));
        assert_eq!((back.mini, back.unlocked), (false, false));
        assert_eq!((back.x, back.y, back.width), (Some(10.0), Some(20.0), Some(600.0)));
        assert_eq!(back.vendor.as_deref(), Some("anthropic"));
        assert_eq!(back.settings["theme"], "dark");
        assert_eq!(back.settings["minimizeToTray"], true, "a missing key takes its default");
        assert_eq!(back.gearbox["gear"], 2);
        assert_eq!(back.gearbox["previous"]["gear"], 4);
        assert!(back.gearbox.get("junk").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
