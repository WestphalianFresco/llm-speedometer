//! The Tauri backend: what the Electron main process used to do, in Rust.
//! The page in `src/renderer` is unchanged; `tauri-shim.js` gives it the same
//! `window.meter` surface the Electron preload did, over these commands.
mod credentials;
mod local;
mod official;
mod paths;
mod pricing;
mod session;
mod store;

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewWindow};

use local::{Scan, Scanner};
use official::OfficialProvider;
use session::{read_account, Account};
use store::UsageStore;

const TICK: Duration = Duration::from_secs(20);
const NORMAL_SIZE: (f64, f64) = (470.0, 432.0);
const MINI_SIZE: (f64, f64) = (278.0, 54.0);

#[derive(Default)]
struct Ui {
    unlocked: bool,
    vendor: Option<String>,
    mini: bool,
}

/// Everything a tick reads and writes, behind one lock. The usage endpoint
/// is polled outside it: a 15 s network wait must not hold up a command.
struct Core {
    scanner: Scanner,
    store: UsageStore,
    ui: Ui,
    scan: Scan,
}

struct AppState {
    core: Mutex<Core>,
    official: Mutex<OfficialProvider>,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

const MODEL_OPTIONS: [(&str, &str); 4] =
    [("fable", "Fable 5.1"), ("opus", "Opus 5.5"), ("sonnet", "Sonnet 5.5"), ("haiku", "Haiku 4.5")];

fn configured_model() -> Option<String> {
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(paths::claude_settings()?).ok()?).ok()?;
    settings.get("model").and_then(|v| v.as_str()).map(str::to_string)
}

fn model_label(value: &str) -> String {
    MODEL_OPTIONS.iter().find(|(v, _)| *v == value).map(|(_, l)| l.to_string()).unwrap_or_else(|| value.to_string())
}

fn vendors(account: Option<&Account>, has_transcripts: bool) -> Value {
    let email = account.and_then(|a| a.email.as_deref());
    let signed_in = email.is_some();
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

/// Re-read the transcripts and the plugin's file. Cheap: only changed files are parsed.
fn refresh_local(core: &mut Core, now: i64) {
    if let Some(projects) = paths::claude_projects() {
        core.scan = core.scanner.scan(&projects, now);
    }
    core.store.ingest_session_file(&core.scan.events, now);
}

/// The single object the page draws from: the Electron `push()` payload.
fn payload(app: &AppHandle, state: &AppState) -> Value {
    let now = now_ms();
    let account = read_account();
    let has_transcripts = paths::claude_projects().map(|p| p.is_dir()).unwrap_or(false);
    let model = configured_model();
    let official = state.official.lock().map(|o| (o.next_allowed_at, o.backing_off(), o.last_error.clone())).unwrap_or((0, false, None));

    let Ok(core) = state.core.lock() else { return Value::Null };
    let scan = &core.scan;
    // The store's half of the payload: windows, budgets, cost, rate, official.
    let official_view = core.store.read(&scan.events, official, now, account.as_ref().and_then(|a| a.plan.as_deref()));
    let model_of = |id: &str| core.scanner.model_of(id);
    let live_sessions = session::list_sessions(&model_of, now);

    let mut out = json!({
        "at": now,
        "account": account.as_ref().map(|a| json!({ "email": a.email, "org": a.org })),
        "session": session::read_session(&scan.last, account.as_ref()),
        "liveSessions": live_sessions,
        "vendors": vendors(account.as_ref(), has_transcripts),
        "odometer": {
            "total": scan.total, "turns": scan.turns, "files": scan.files,
            "trip": scan.trip, "tripTurns": scan.trip_turns, "tripSessionId": scan.trip_session_id,
        },
        "configuredModel": model.as_deref().map(model_label),
        "configuredModelValue": model,
        "configuredModelFamily": model,
        "modelOptions": MODEL_OPTIONS.iter().map(|(v, l)| json!({ "value": v, "label": l })).collect::<Vec<_>>(),
        "appVersion": app.package_info().version.to_string(),
        "unlocked": core.ui.unlocked,
        "vendor": core.ui.vendor,
        "mini": core.ui.mini,
        "settings": { "theme": "system", "opacity": 1, "alwaysOnTop": true, "openAtLogin": false, "sound": true,
                      "volume": 0.8, "showSessions": true, "minimizeToTray": true, "gearboxHintSeen": false },
        "gearbox": { "providerId": null, "gear": null, "previous": null },
        "catalog": null,
        "darkMode": false,
        "canOpenAtLogin": false,
        "streamDeck": { "deckInstalled": false, "pluginInstalled": false, "canInstall": false },
    });
    if let (Some(a), Some(b)) = (out.as_object_mut(), official_view.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    out["budget"]["lifetime"] = json!({ "usedTokens": scan.total, "turns": scan.turns });
    out
}

fn push(app: &AppHandle) {
    let state = app.state::<AppState>();
    let value = payload(app, &state);
    // ponytail: dev-log summary, one line per push; drop once a tray tooltip shows the same.
    eprintln!(
        "[reading] odo={} trip={} rate={:.0} wk={:.1}%/{} resets={} used={} turns={} covered={:.2} 5h={:.1}%/{} left~{:.0} events={} files={}",
        value["odometer"]["total"], value["odometer"]["trip"], value["tokensPerMinute"].as_f64().unwrap_or(0.0),
        value["sevenDay"]["percent"].as_f64().unwrap_or(-1.0), value["sevenDay"]["source"], value["sevenDay"]["resetsAt"],
        value["budget"]["sevenDay"]["usedTokens"], value["budget"]["sevenDay"]["turns"], value["budget"]["sevenDay"]["covered"].as_f64().unwrap_or(-1.0),
        value["fiveHour"]["percent"].as_f64().unwrap_or(-1.0), value["fiveHour"]["source"],
        value["budget"]["sevenDay"]["remainingTokens"].as_f64().unwrap_or(-1.0), value["localEvents"], value["odometer"]["files"]
    );
    let _ = app.emit("usage:update", value);
}

/// One tick: re-read what is local and push it, then ask the endpoint if it
/// is time and push again. The local reading never waits on the network, nor
/// on the Keychain prompt a first run raises: a poll already under way is
/// left alone (`try_lock`), and the next tick finds its result.
fn tick(app: &AppHandle, force_official: bool) {
    let state = app.state::<AppState>();
    let now = now_ms();
    if let Ok(mut core) = state.core.lock() {
        refresh_local(&mut core, now);
    }
    push(app);

    let Ok(mut official) = state.official.try_lock() else { return };
    if !(force_official || now >= official.next_allowed_at) {
        return;
    }
    let fetch = official.fetch(now_ms(), force_official);
    drop(official);
    if let Ok(mut core) = state.core.lock() {
        let events = core.scan.events.clone();
        core.store.ingest_official(&fetch, &events, now_ms());
    }
    if fetch.status != "ok" {
        eprintln!("[official] {} {}", fetch.status, fetch.reason.as_deref().unwrap_or(""));
    }
    push(app);
}

#[tauri::command]
fn ready(app: AppHandle) {
    eprintln!("[ui] ready: the page ran to its end and asked for the first reading");
    let app2 = app.clone();
    std::thread::spawn(move || tick(&app2, false));
}

/// What the page could not say otherwise: a webview has no terminal, so its
/// errors come here and land in the process log.
#[tauri::command]
fn ui_log(text: String) {
    eprintln!("[ui] {}", text.chars().take(600).collect::<String>());
}

/// The pill's button and the tray's Refresh: a forced poll that still
/// respects the endpoint's hard floor.
#[tauri::command]
fn refresh(app: AppHandle) {
    let app2 = app.clone();
    std::thread::spawn(move || tick(&app2, true));
}

#[tauri::command]
fn close(app: AppHandle, state: State<AppState>) {
    if let Ok(core) = state.core.lock() {
        core.store.save();
    }
    app.exit(0)
}

#[tauri::command]
fn minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn set_mini(app: AppHandle, window: WebviewWindow, state: State<AppState>, mini: bool) {
    if let Ok(mut core) = state.core.lock() {
        core.ui.mini = mini;
    }
    let (w, h) = if mini { MINI_SIZE } else { NORMAL_SIZE };
    let _ = window.set_size(LogicalSize::new(w, h));
    push(&app)
}

#[tauri::command]
fn lock(app: AppHandle, state: State<AppState>) {
    if let Ok(mut core) = state.core.lock() {
        core.ui.unlocked = false;
    }
    push(&app)
}

#[tauri::command]
fn unlock(app: AppHandle, state: State<AppState>, vendor_id: String) -> Value {
    if vendor_id != "anthropic" {
        return json!({ "ok": false, "reason": "not_ported" });
    }
    let signed_in = read_account().and_then(|a| a.email).is_some();
    let has_transcripts = paths::claude_projects().map(|p| p.is_dir()).unwrap_or(false);
    if !(signed_in && has_transcripts) {
        return json!({ "ok": false, "reason": "not_usable" });
    }
    if let Ok(mut core) = state.core.lock() {
        core.ui.unlocked = true;
        core.ui.vendor = Some(vendor_id);
    }
    push(&app);
    json!({ "ok": true })
}

// ponytail: stage 2 answers these honestly instead of doing them; each lands
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
    let store = UsageStore::new(
        paths::app_data_dir().map(|d| d.join("state.json")),
        paths::speedometer_dir().map(|d| d.join("reading.json")),
    );
    tauri::Builder::default()
        .manage(AppState {
            core: Mutex::new(Core { scanner: Scanner::default(), store, ui: Ui::default(), scan: Scan::default() }),
            official: Mutex::new(OfficialProvider::default()),
        })
        .invoke_handler(tauri::generate_handler![
            ready, refresh, close, minimize, set_mini, lock, unlock, ui_log,
            set_model, open_vendor, set_setting, reset_settings, install_streamdeck, set_gear
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(TICK);
                tick(&handle, false);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LLM Speedometer");
}
