//! The Tauri backend: what the Electron main process used to do, in Rust.
//! The page in `src/renderer` is unchanged; `tauri-shim.js` gives it the same
//! `window.meter` surface the Electron preload did, over these commands.
mod transcripts;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewWindow};
use transcripts::{rate_per_minute, Scan, Scanner};

const TICK: Duration = Duration::from_secs(20);
const RATE_WINDOW_MS: i64 = 10 * 60 * 1000;
/// A reading left by a Claude Code session running the plugin is current for
/// this long; after that the session has stopped writing and says nothing.
const SESSION_FILE_MAX_AGE_MS: i64 = 15 * 60 * 1000;
const NORMAL_SIZE: (f64, f64) = (470.0, 432.0);
const MINI_SIZE: (f64, f64) = (278.0, 54.0);

#[derive(Default)]
struct Ui {
    unlocked: bool,
    vendor: Option<String>,
    mini: bool,
}

struct AppState {
    scanner: Mutex<Scanner>,
    ui: Mutex<Ui>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// `~/.claude`, or wherever `CLAUDE_CONFIG_DIR` points: authoritative when set.
fn claude_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    home().map(|h| h.join(".claude"))
}

fn read_json(path: &std::path::Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `default_claude_max_5x` → `Max 5x`, as the Electron app spelled it.
fn pretty_plan(tier: &str) -> String {
    match tier {
        "default_claude_max_5x" => "Max 5x".into(),
        "default_claude_max_20x" => "Max 20x".into(),
        "default_claude_max" => "Max".into(),
        "default_claude_pro" => "Pro".into(),
        "default_claude_team" => "Team".into(),
        "default" => "Free".into(),
        other => other
            .trim_start_matches("default_")
            .trim_start_matches("claude_")
            .split('_')
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// The signed-in account from `~/.claude.json`: email, org, plan.
fn account() -> (Value, Option<String>) {
    let Some(cfg) = home().and_then(|h| read_json(&h.join(".claude.json"))) else { return (Value::Null, None) };
    let Some(acct) = cfg.get("oauthAccount") else { return (Value::Null, None) };
    let text = |k: &str| acct.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let plan = text("organizationRateLimitTier").or_else(|| text("userRateLimitTier")).map(|t| pretty_plan(&t));
    (json!({ "email": text("emailAddress"), "org": text("organizationName") }), plan)
}

const MODEL_OPTIONS: [(&str, &str); 4] =
    [("fable", "Fable 5.1"), ("opus", "Opus 5.5"), ("sonnet", "Sonnet 5.5"), ("haiku", "Haiku 4.5")];

fn configured_model() -> Option<String> {
    let settings = read_json(&claude_dir()?.join("settings.json"))?;
    settings.get("model").and_then(|v| v.as_str()).map(str::to_string)
}

fn model_label(value: &str) -> String {
    MODEL_OPTIONS.iter().find(|(v, _)| *v == value).map(|(_, l)| l.to_string()).unwrap_or_else(|| value.to_string())
}

/// `~/.llm-speedometer/reading.json`, the file the Claude Code plugin writes
/// with every reply, while it is fresh. Stage 1's only quota source.
fn session_file(now: i64) -> Option<Value> {
    let r = read_json(&home()?.join(".llm-speedometer").join("reading.json"))?;
    if r.get("v")?.as_i64()? != 1 || r.get("source")?.as_str()? != "claude-code" {
        return None;
    }
    let at = r.get("at")?.as_i64()?;
    if now - at > SESSION_FILE_MAX_AGE_MS {
        return None;
    }
    Some(r)
}

/// One quota window in the shape the page reads: percent *used*, and where it
/// came from.
fn window(tank: Option<&Value>, at: Option<i64>) -> Value {
    let left = tank.and_then(|t| t.get("percentLeft")).and_then(|v| v.as_f64());
    match left {
        Some(left) => json!({
            "percent": (100.0 - left).clamp(0.0, 100.0),
            "source": "official",
            "confidence": "exact",
            "anchorAt": at,
            "resetsAt": tank.and_then(|t| t.get("resetsAt")).and_then(|v| v.as_i64()),
        }),
        None => json!({ "percent": null, "source": "uncalibrated", "confidence": "unknown", "anchorAt": null, "resetsAt": null }),
    }
}

fn empty_budget() -> Value {
    json!({ "windowStart": null, "resetsAt": null, "usedTokens": 0, "usedCost": 0, "turns": 0, "covered": 0,
            "capacityTokens": null, "remainingTokens": null, "confidence": "unknown" })
}

fn vendors(signed_in: bool, has_transcripts: bool, email: Option<&str>) -> Value {
    json!([
        { "id": "anthropic", "name": "Anthropic", "product": "Claude Code", "url": "https://claude.ai/login",
          "supported": true, "signInHint": "Run `claude` in a terminal and follow the sign-in prompt.",
          "present": signed_in, "usable": signed_in && has_transcripts, "account": email,
          "note": if !signed_in { "Not signed in on this machine." } else if has_transcripts { "Signed in. Usage and quota available." } else { "Signed in, but no transcripts found yet." } },
        { "id": "openai", "name": "OpenAI", "product": "Codex CLI", "url": "https://chatgpt.com/", "supported": true, "signInHint": null,
          "present": false, "usable": false, "account": null, "note": "Not ported to this build yet." },
        { "id": "google", "name": "Google", "product": "Gemini CLI", "url": "https://gemini.google.com/", "supported": false, "signInHint": null,
          "present": false, "usable": false, "account": null, "note": "Not supported." }
    ])
}

/// The single object the page draws from: the Electron `push()` payload.
fn payload(app: &AppHandle, state: &AppState) -> Value {
    let now = now_ms();
    let projects = claude_dir().map(|d| d.join("projects"));
    let scan: Scan = match &projects {
        Some(p) => state.scanner.lock().map(|mut s| s.scan(p, now)).unwrap_or_default(),
        None => Scan::default(),
    };
    let (acct, plan) = account();
    let email = acct.get("email").and_then(|v| v.as_str()).map(str::to_string);
    let has_transcripts = projects.as_ref().map(|p| p.is_dir()).unwrap_or(false);
    let file = session_file(now);
    let at = file.as_ref().and_then(|f| f.get("at")).and_then(|v| v.as_i64());
    let five_hour = window(file.as_ref().and_then(|f| f.get("fiveHour")), at);
    let seven_day = window(file.as_ref().and_then(|f| f.get("sevenDay")), at);
    let model = configured_model();
    let ui = state.ui.lock().map(|u| (u.unlocked, u.vendor.clone(), u.mini)).unwrap_or((false, None, false));

    json!({
        "at": now,
        "account": acct,
        "session": {
            "version": scan.last.version,
            "model": scan.last.model.as_deref().map(pretty_model),
            "modelId": scan.last.model,
            "effort": null,
            "plan": plan,
            "cwd": scan.last.cwd,
            "sessionName": null,
            "company": if scan.last.model.is_some() { Some("Anthropic") } else { None },
        },
        "liveSessions": [],
        "vendors": vendors(email.is_some(), has_transcripts, email.as_deref()),
        "odometer": {
            "total": scan.total, "turns": scan.turns, "files": scan.files,
            "trip": scan.trip, "tripTurns": scan.trip_turns, "tripSessionId": scan.trip_session_id,
        },
        "configuredModel": model.as_deref().map(model_label),
        "configuredModelValue": model,
        "configuredModelFamily": model,
        "modelOptions": MODEL_OPTIONS.iter().map(|(v, l)| json!({ "value": v, "label": l })).collect::<Vec<_>>(),
        "fiveHour": json!({ "label": "5-hour" }).merge(five_hour),
        "sevenDay": json!({ "label": "This week" }).merge(seven_day),
        "weeklyScoped": null,
        "spend": { "fiveHour": 0, "sevenDay": 0 },
        "quotaRate": { "fiveHour": null, "sevenDay": null },
        "budget": {
            "fiveHour": empty_budget(),
            "sevenDay": empty_budget(),
            "lifetime": { "usedTokens": scan.total, "turns": scan.turns },
        },
        "cost": { "fiveHour": 0, "sevenDay": 0, "lifetime": null, "official": null, "plan": plan,
                  "pricing": { "asOf": null, "source": null, "overridden": false,
                               "overrideFile": home().map(|h| h.join(".llm-speedometer").join("pricing.json").to_string_lossy().into_owned()) } },
        "tokensPerMinute": rate_per_minute(&scan.events, now, RATE_WINDOW_MS),
        "calibrated": false,
        "official": { "lastAttempt": null, "nextPollAt": null, "backingOff": false, "reason": null },
        "localEvents": scan.events.len(),
        "appVersion": app.package_info().version.to_string(),
        "unlocked": ui.0,
        "vendor": ui.1,
        "mini": ui.2,
        "settings": { "theme": "system", "opacity": 1, "alwaysOnTop": true, "openAtLogin": false, "sound": true,
                      "volume": 0.8, "showSessions": true, "minimizeToTray": true, "gearboxHintSeen": false },
        "gearbox": { "providerId": null, "gear": null, "previous": null },
        "catalog": null,
        "darkMode": false,
        "canOpenAtLogin": false,
        "streamDeck": { "deckInstalled": false, "pluginInstalled": false, "canInstall": false },
    })
}

/// `claude-opus-5-5` → `Opus 5.5`, roughly as the Electron app did.
fn pretty_model(id: &str) -> String {
    let base = id.split('[').next().unwrap_or(id);
    let rest = base.strip_prefix("claude-").unwrap_or(base);
    let mut parts = rest.split('-');
    let family = parts.next().unwrap_or(rest);
    // version digits only: a trailing date stamp (20251001) is not a version
    let version: Vec<&str> =
        parts.take_while(|p| !p.is_empty() && p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit())).collect();
    let mut c = family.chars();
    let name = match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    };
    if version.is_empty() { name } else { format!("{name} {}", version.join(".")) }
}

trait Merge {
    fn merge(self, other: Value) -> Value;
}
impl Merge for Value {
    fn merge(mut self, other: Value) -> Value {
        if let (Some(a), Some(b)) = (self.as_object_mut(), other.as_object()) {
            for (k, v) in b {
                a.insert(k.clone(), v.clone());
            }
        }
        self
    }
}

fn push(app: &AppHandle) {
    let state = app.state::<AppState>();
    let value = payload(app, &state);
    // ponytail: dev-log summary, one line per push; drop once a tray tooltip shows the same.
    eprintln!(
        "[reading] odo={} trip={} rate={:.0} wk_used={} 5h_used={} files={}",
        value["odometer"]["total"], value["odometer"]["trip"], value["tokensPerMinute"].as_f64().unwrap_or(0.0),
        value["sevenDay"]["percent"], value["fiveHour"]["percent"], value["odometer"]["files"]
    );
    let _ = app.emit("usage:update", value);
}

#[tauri::command]
fn ready(app: AppHandle) {
    eprintln!("[ui] ready: the page ran to its end and asked for the first reading");
    push(&app)
}

/// What the page could not say otherwise: a webview has no terminal, so its
/// errors come here and land in the process log.
#[tauri::command]
fn ui_log(text: String) {
    eprintln!("[ui] {}", text.chars().take(600).collect::<String>());
}

#[tauri::command]
fn refresh(app: AppHandle) {
    push(&app)
}

#[tauri::command]
fn close(app: AppHandle) {
    app.exit(0)
}

#[tauri::command]
fn minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn set_mini(app: AppHandle, window: WebviewWindow, state: State<AppState>, mini: bool) {
    if let Ok(mut ui) = state.ui.lock() {
        ui.mini = mini;
    }
    let (w, h) = if mini { MINI_SIZE } else { NORMAL_SIZE };
    let _ = window.set_size(LogicalSize::new(w, h));
    push(&app)
}

#[tauri::command]
fn lock(app: AppHandle, state: State<AppState>) {
    if let Ok(mut ui) = state.ui.lock() {
        ui.unlocked = false;
    }
    push(&app)
}

#[tauri::command]
fn unlock(app: AppHandle, state: State<AppState>, vendor_id: String) -> Value {
    if vendor_id != "anthropic" {
        return json!({ "ok": false, "reason": "not_ported" });
    }
    let (acct, _) = account();
    let signed_in = acct.get("email").and_then(|v| v.as_str()).is_some();
    let has_transcripts = claude_dir().map(|d| d.join("projects").is_dir()).unwrap_or(false);
    if !(signed_in && has_transcripts) {
        return json!({ "ok": false, "reason": "not_usable" });
    }
    if let Ok(mut ui) = state.ui.lock() {
        ui.unlocked = true;
        ui.vendor = Some(vendor_id);
    }
    push(&app);
    json!({ "ok": true })
}

// ponytail: stage 1 answers these honestly instead of doing them; each lands
// with the subsystem it belongs to (settings.json writes, tray, Stream Deck).
#[tauri::command]
fn set_model(_value: String) -> Value {
    json!({ "ok": false, "reason": "not_ported" })
}
#[tauri::command]
fn open_vendor(_vendor_id: String) -> Value {
    json!({ "ok": false, "reason": "not_ported" })
}
#[tauri::command]
fn set_setting(_key: String, _value: Value) -> Value {
    json!({ "ok": false, "reason": "not_ported" })
}
#[tauri::command]
fn reset_settings() -> Value {
    json!({ "ok": false, "reason": "not_ported" })
}
#[tauri::command]
fn install_streamdeck() -> Value {
    json!({ "ok": false, "reason": "not_ported" })
}
#[tauri::command]
fn set_gear(_provider_id: String, _gear: Value) -> Value {
    json!({ "ok": false, "reason": "not_ported" })
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState { scanner: Mutex::new(Scanner::default()), ui: Mutex::new(Ui::default()) })
        .invoke_handler(tauri::generate_handler![
            ready, refresh, close, minimize, set_mini, lock, unlock, ui_log,
            set_model, open_vendor, set_setting, reset_settings, install_streamdeck, set_gear
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(TICK);
                push(&handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LLM Speedometer");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_and_models_read_as_the_app_spelled_them() {
        assert_eq!(pretty_plan("default_claude_max_5x"), "Max 5x");
        assert_eq!(pretty_plan("default"), "Free");
        assert_eq!(pretty_plan("default_claude_enterprise_plus"), "Enterprise Plus");
        assert_eq!(pretty_model("claude-opus-5-5"), "Opus 5.5");
        assert_eq!(pretty_model("claude-haiku-4-5-20251001"), "Haiku 4.5");
        assert_eq!(pretty_model("gpt-5"), "Gpt 5");
        assert_eq!(pretty_model("claude-opus-5-5[1m]"), "Opus 5.5");
    }

    #[test]
    fn a_window_is_percent_used_or_honestly_unknown() {
        let w = window(Some(&json!({ "percentLeft": 87, "resetsAt": 5 })), Some(1));
        assert_eq!(w["percent"], 13.0);
        assert_eq!(w["source"], "official");
        assert_eq!(w["resetsAt"], 5);
        let none = window(Some(&json!({ "percentLeft": null })), Some(1));
        assert_eq!(none["percent"], Value::Null);
        assert_eq!(none["source"], "uncalibrated");
        assert_eq!(window(None, None)["percent"], Value::Null);
        assert_eq!(window(Some(&json!({ "percentLeft": 130 })), None)["percent"], 0.0);
    }
}
