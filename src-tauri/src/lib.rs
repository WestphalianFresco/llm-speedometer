//! The Tauri backend: what the Electron main process used to do, in Rust.
//! The page in `src/renderer` is unchanged; `tauri-shim.js` gives it the same
//! `window.meter` surface the Electron preload did, over these commands.
mod bridge;
mod codex;
mod credentials;
mod gearbox;
mod local;
mod official;
mod paths;
mod platform;
mod pricing;
mod session;
mod store;
mod tray;
mod ui;
mod updater;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, Theme, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;

use bridge::{Bridge, Hooks};
use local::{Scan, Scanner};
use official::OfficialProvider;
use session::{read_account, Account};
use store::UsageStore;
use ui::{ASPECT, MAX_SCALE, MIN_SCALE, MINI_SIZE, NORMAL_SIZE, UiState};

const TICK: Duration = Duration::from_secs(20);
const SCREEN_MARGIN: f64 = 24.0;
/// A key that read the bridge this recently counts as connected.
const DECK_SEEN_MS: i64 = 15 * 1000;

/// Everything a tick reads and writes, behind one lock. The usage endpoint
/// is polled outside it: a 15 s network wait must not hold up a command.
struct Core {
    /// Which provider's store is mounted: `anthropic` or `openai`.
    vendor: String,
    scanner: Scanner,
    store: UsageStore,
    codex: codex::CodexStore,
    ui: UiState,
    scan: Scan,
}

struct AppState {
    core: Mutex<Core>,
    official: Mutex<OfficialProvider>,
    bridge: Mutex<Option<Bridge>>,
    tray: Mutex<Option<tray::Tray<tauri::Wry>>>,
    /// The last payload pushed, which the bridge serves without a re-read.
    last_payload: Mutex<Value>,
    ui_path: Option<PathBuf>,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn configured_model() -> Option<String> {
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(paths::claude_settings()?).ok()?).ok()?;
    settings.get("model").and_then(|v| v.as_str()).map(str::to_string)
}

fn vendors(account: Option<&Account>, has_transcripts: bool) -> Value {
    let email = account.and_then(|a| a.email.as_deref());
    let signed_in = email.is_some();
    let mut openai = json!({ "id": "openai", "name": "OpenAI", "product": "Codex CLI", "url": "https://chatgpt.com/", "supported": true, "signInHint": null });
    if let (Some(a), Some(b)) = (openai.as_object_mut(), codex::detect().as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    json!([
        { "id": "anthropic", "name": "Anthropic", "product": "Claude Code", "url": "https://claude.ai/login",
          "supported": true, "signInHint": "Run `claude` in a terminal and follow the sign-in prompt.",
          "present": signed_in, "usable": signed_in && has_transcripts, "account": email,
          "note": if !signed_in { "Not signed in on this machine." } else if has_transcripts { "Signed in. Usage and quota available." } else { "Signed in, but no transcripts found yet." } },
        openai,
        { "id": "google", "name": "Google", "product": "Gemini CLI", "url": "https://gemini.google.com/", "supported": false, "signInHint": null,
          "present": false, "usable": false, "account": null, "note": "Not supported." }
    ])
}

/// Re-read the transcripts and the plugin's file. Cheap: only changed files are parsed.
fn refresh_local(core: &mut Core, now: i64) {
    if core.vendor == "openai" {
        core.codex.refresh_local(now);
        return;
    }
    if let Some(projects) = paths::claude_projects() {
        core.scan = core.scanner.scan(&projects, now);
    }
    core.store.ingest_session_file(&core.scan.events, now);
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("main")
}

/// Where the bundle put the packed Stream Deck plugin, if this is a bundle.
fn bundled_plugin(app: &AppHandle) -> Option<PathBuf> {
    app.path().resolve(format!("../build/{}.streamDeckPlugin", platform::PLUGIN_UUID), BaseDirectory::Resource).ok()
}

fn deck_status(app: &AppHandle, state: &AppState) -> Value {
    let mut status = platform::stream_deck_status(bundled_plugin(app));
    let (port, seen_at, keys) = state.bridge.lock().ok().and_then(|b| b.as_ref().map(|b| b.status())).unwrap_or((0, 0, 0));
    let connected = port != 0 && now_ms() - seen_at < DECK_SEEN_MS;
    status["bridge"] = json!(port != 0);
    status["connected"] = json!(connected);
    status["keys"] = json!(if connected { keys } else { 0 });
    status
}

/// The single object the page draws from: the Electron `push()` payload.
fn payload(app: &AppHandle, state: &AppState) -> Value {
    let now = now_ms();
    let account = read_account();
    let has_transcripts = paths::claude_projects().map(|p| p.is_dir()).unwrap_or(false);
    let model = configured_model();
    let official = state.official.lock().map(|o| (o.next_allowed_at, o.backing_off(), o.last_error.clone())).unwrap_or((0, false, None));
    let deck = deck_status(app, state);
    let dark = main_window(app).and_then(|w| w.theme().ok()).map(|t| t == Theme::Dark).unwrap_or(false);

    let Ok(core) = state.core.lock() else { return Value::Null };
    let common = json!({
        "vendors": vendors(account.as_ref(), has_transcripts),
        "appVersion": app.package_info().version.to_string(),
        "unlocked": core.ui.unlocked,
        "vendor": core.ui.vendor,
        "mini": core.ui.mini,
        "settings": core.ui.settings,
        "gearbox": core.ui.gearbox,
        // the catalogue travels with the payload so the page draws gears from
        // the same list the backend validates against
        "catalog": gearbox::providers(),
        "darkMode": dark,
        // a dev checkout run through `tauri dev` must not register itself at login
        "canOpenAtLogin": !cfg!(debug_assertions),
        "streamDeck": deck,
    });
    let merge = |mut base: Value, extra: &Value| {
        if let (Some(a), Some(b)) = (base.as_object_mut(), extra.as_object()) {
            for (k, v) in b {
                a.insert(k.clone(), v.clone());
            }
        }
        base
    };
    // Codex: the rollouts carry everything, quota included; nothing to merge in
    if core.vendor == "openai" {
        return merge(core.codex.read(now), &common);
    }

    let scan = &core.scan;
    let official_view = core.store.read(&scan.events, official, now, account.as_ref().and_then(|a| a.plan.as_deref()));
    let model_of = |id: &str| core.scanner.model_of(id);
    let live_sessions = session::list_sessions(&model_of, now);

    let out = json!({
        "at": now,
        "account": account.as_ref().map(|a| json!({ "email": a.email, "org": a.org })),
        "session": session::read_session(&scan.last, account.as_ref()),
        "liveSessions": live_sessions,
        "vendors": vendors(account.as_ref(), has_transcripts),
        "odometer": {
            "total": scan.total, "turns": scan.turns, "files": scan.files,
            "trip": scan.trip, "tripTurns": scan.trip_turns, "tripSessionId": scan.trip_session_id,
        },
        "configuredModel": model.as_deref().map(gearbox::label_for),
        "configuredModelValue": model,
        "configuredModelFamily": model.as_deref().and_then(gearbox::model_family),
        "modelOptions": gearbox::model_options(),
    });
    let mut out = merge(merge(out, &official_view), &common);
    out["budget"]["lifetime"] = json!({ "usedTokens": scan.total, "turns": scan.turns });
    out
}

fn push(app: &AppHandle) {
    let state = app.state::<AppState>();
    let value = payload(app, &state);
    if let Ok(tray) = state.tray.lock() {
        if let Some(t) = tray.as_ref() {
            let _ = t.icon.set_tooltip(Some(tray::tooltip(Some(&value))));
        }
    }
    if let Ok(mut last) = state.last_payload.lock() {
        *last = value.clone();
    }
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

    if state.core.lock().map(|c| c.vendor != "anthropic").unwrap_or(true) {
        return;
    }
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

fn save_ui(state: &AppState, core: &Core) {
    core.ui.save(state.ui_path.as_ref());
}

// ---------- window geometry ----------

/// The expanded size: the remembered width, with the height from the aspect.
fn normal_size(ui: &UiState) -> (f64, f64) {
    let w = ui.width.unwrap_or(NORMAL_SIZE.0);
    (w, (w / ASPECT).round())
}

/// Bottom-right of the primary screen, or the saved spot if it still fits a
/// screen after a monitor change.
fn place<R: Runtime>(window: &WebviewWindow<R>, saved: (Option<f64>, Option<f64>), size: (f64, f64)) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let screens: Vec<(f64, f64, f64, f64)> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| (m.position().x as f64 / scale, m.position().y as f64 / scale, m.size().width as f64 / scale, m.size().height as f64 / scale))
        .collect();
    if let (Some(x), Some(y)) = saved {
        let fits = screens.iter().any(|(sx, sy, sw, sh)| x + size.0 > *sx && x < sx + sw && y + size.1 > *sy && y < sy + sh);
        if fits {
            return (x, y);
        }
    }
    let primary = window.primary_monitor().ok().flatten().map(|m| (m.position().x as f64 / scale, m.position().y as f64 / scale, m.size().width as f64 / scale, m.size().height as f64 / scale));
    let (sx, sy, sw, sh) = primary.unwrap_or((0.0, 0.0, 1440.0, 900.0));
    // ponytail: no work-area query, so a margin stands in for the dock and taskbar
    (sx + sw - size.0 - SCREEN_MARGIN, sy + sh - size.1 - SCREEN_MARGIN * 3.0)
}

/// Resize rules for the state: expanded is resizable, aspect-locked and
/// bounded; collapsed is fixed, because a pill that grows is empty space.
fn apply_resize_mode<R: Runtime>(window: &WebviewWindow<R>, mini: bool) {
    if mini {
        let _ = window.set_resizable(false);
        let _ = window.set_min_size(None::<LogicalSize<f64>>);
        let _ = window.set_max_size(None::<LogicalSize<f64>>);
        let _ = window.set_zoom(1.0);
    } else {
        let _ = window.set_resizable(true);
        let _ = window.set_min_size(Some(LogicalSize::new(NORMAL_SIZE.0 * MIN_SCALE, NORMAL_SIZE.1 * MIN_SCALE)));
        let _ = window.set_max_size(Some(LogicalSize::new(NORMAL_SIZE.0 * MAX_SCALE, NORMAL_SIZE.1 * MAX_SCALE)));
        if let Ok(size) = window.outer_size() {
            let scale = window.scale_factor().unwrap_or(1.0);
            let _ = window.set_zoom(size.width as f64 / scale / NORMAL_SIZE.0);
        }
    }
}

fn apply_mini(app: &AppHandle, mini: bool) {
    let state = app.state::<AppState>();
    let Some(window) = main_window(app) else { return };
    let (size, pos) = {
        let Ok(mut core) = state.core.lock() else { return };
        core.ui.mini = mini;
        let size = if mini { MINI_SIZE } else { normal_size(&core.ui) };
        let scale = window.scale_factor().unwrap_or(1.0);
        let here = window.outer_position().ok().map(|p| (p.x as f64 / scale, p.y as f64 / scale));
        save_ui(&state, &core);
        (size, here)
    };
    let _ = window.set_resizable(true);
    let _ = window.set_min_size(None::<LogicalSize<f64>>);
    let _ = window.set_max_size(None::<LogicalSize<f64>>);
    let (x, y) = place(&window, (pos.map(|p| p.0), pos.map(|p| p.1)), size);
    let _ = window.set_position(LogicalPosition::new(x, y));
    let _ = window.set_size(LogicalSize::new(size.0, size.1));
    apply_resize_mode(&window, mini);
    push(app);
}

/// Push every setting out to the thing that enforces it: one path, called
/// at startup and after each change.
fn apply_settings(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (theme, on_top, minimize_to_tray, want_bridge, open_at_login) = {
        let Ok(core) = state.core.lock() else { return };
        (core.ui.settings["theme"].as_str().unwrap_or("system").to_string(), core.ui.flag("alwaysOnTop"), core.ui.flag("minimizeToTray"), core.ui.flag("streamDeck"), core.ui.flag("openAtLogin"))
    };
    if let Some(window) = main_window(app) {
        let _ = window.set_always_on_top(on_top);
        let _ = window.set_theme(match theme.as_str() { "light" => Some(Theme::Light), "dark" => Some(Theme::Dark), _ => None });
    }
    if let Ok(tray) = state.tray.lock() {
        if let Some(t) = tray.as_ref() {
            let _ = t.always_on_top.set_checked(on_top);
            let _ = t.minimize_to_tray.set_checked(minimize_to_tray);
        }
    }
    sync_bridge(app, want_bridge);
    if !cfg!(debug_assertions) {
        let launch = app.autolaunch();
        let _ = if open_at_login { launch.enable() } else { launch.disable() };
    }
}

/// Open or close the loopback port to match the setting.
fn sync_bridge(app: &AppHandle, wanted: bool) {
    let state = app.state::<AppState>();
    let Ok(mut bridge) = state.bridge.lock() else { return };
    if wanted && bridge.is_none() {
        let (read_app, refresh_app, show_app) = (app.clone(), app.clone(), app.clone());
        *bridge = Bridge::start(Hooks {
            read: Box::new(move || {
                let st = read_app.state::<AppState>();
                let last = st.last_payload.lock().ok()?.clone();
                if last.is_null() {
                    return None;
                }
                let (vendor, unlocked) = st.core.lock().map(|c| (c.ui.vendor.clone(), c.ui.unlocked)).unwrap_or((None, false));
                Some(bridge::summarise(&last, json!({ "vendor": vendor, "unlocked": unlocked })))
            }),
            refresh: Box::new(move || {
                let a = refresh_app.clone();
                std::thread::spawn(move || tick(&a, true));
            }),
            show: Box::new(move || reveal_window(&show_app)),
            launch: json!({ "command": std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(), "args": [] }),
        });
    } else if !wanted {
        if let Some(b) = bridge.take() {
            b.stop();
        }
    }
}

/// Bring the window back: hidden, minimised or merely buried each need a
/// different call, so all three are made.
pub fn reveal_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = main_window(app) else { return };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(mut bridge) = state.bridge.lock() {
        if let Some(b) = bridge.take() {
            b.stop();
        }
    }
    if let Ok(core) = state.core.lock() {
        core.store.save();
        save_ui(&state, &core);
    }
}

// ---------- commands: the preload's surface ----------

#[tauri::command]
fn ready(app: AppHandle) {
    eprintln!("[ui] ready: the page ran to its end and asked for the first reading");
    let app2 = app.clone();
    std::thread::spawn(move || tick(&app2, false));
}

/// A webview has no terminal: page errors come here and land in the log.
#[tauri::command]
fn ui_log(text: String) {
    eprintln!("[ui] {}", text.chars().take(600).collect::<String>());
}

#[tauri::command]
fn refresh(app: AppHandle) {
    let app2 = app.clone();
    std::thread::spawn(move || tick(&app2, true));
}

#[tauri::command]
fn close(app: AppHandle) {
    shutdown(&app);
    app.exit(0)
}

/// Minimising goes to the notification area when there is one and the
/// setting says so; collapsing to the pill is a different control.
#[tauri::command]
fn minimize(app: AppHandle, window: WebviewWindow, state: State<AppState>) {
    let to_tray = state.core.lock().map(|c| c.ui.flag("minimizeToTray")).unwrap_or(false) && state.tray.lock().map(|t| t.is_some()).unwrap_or(false);
    if to_tray {
        let _ = window.hide();
        push(&app);
    } else {
        let _ = window.minimize();
    }
}

#[tauri::command]
fn set_mini(app: AppHandle, mini: bool) {
    apply_mini(&app, mini)
}

#[tauri::command]
fn lock(app: AppHandle, state: State<AppState>) {
    if let Ok(mut core) = state.core.lock() {
        core.ui.unlocked = false;
        save_ui(&state, &core);
    }
    push(&app)
}

#[tauri::command]
fn unlock(app: AppHandle, state: State<AppState>, vendor_id: String) -> Value {
    let account = read_account();
    let has_transcripts = paths::claude_projects().map(|p| p.is_dir()).unwrap_or(false);
    let list = vendors(account.as_ref(), has_transcripts);
    let Some(vendor) = list.as_array().and_then(|l| l.iter().find(|v| v["id"] == vendor_id.as_str())).cloned() else {
        return json!({ "ok": false, "reason": "unknown_vendor" });
    };
    if vendor["usable"] != true {
        return json!({ "ok": false, "reason": "not_usable", "vendor": vendor });
    }
    if let Ok(mut core) = state.core.lock() {
        core.ui.unlocked = true;
        core.ui.vendor = Some(vendor_id.clone());
        // mount the vendor's store, so the first reading is already warm
        if core.vendor != vendor_id {
            core.vendor = vendor_id;
            refresh_local(&mut core, now_ms());
        }
        save_ui(&state, &core);
    }
    push(&app);
    json!({ "ok": true, "vendor": vendor })
}

#[tauri::command]
fn set_model(app: AppHandle, value: String) -> Value {
    let result = gearbox::write_model(&value);
    if result["ok"] == true {
        push(&app);
    }
    result
}

#[tauri::command]
fn open_vendor(vendor_id: String) -> Value {
    let list = vendors(read_account().as_ref(), true);
    match list.as_array().and_then(|l| l.iter().find(|v| v["id"] == vendor_id.as_str())).and_then(|v| v["url"].as_str()) {
        Some(url) => platform::open_external(url),
        None => json!({ "ok": false, "reason": "unknown_vendor" }),
    }
}

/// One setting at a time, answered with the whole block so the page never
/// has to guess what was accepted.
#[tauri::command]
fn set_setting(app: AppHandle, state: State<AppState>, key: String, value: Value) -> Value {
    let Some(coerced) = ui::coerce_setting(&key, &value) else { return json!({ "ok": false, "reason": "unknown_setting" }) };
    let settings = {
        let Ok(mut core) = state.core.lock() else { return json!({ "ok": false, "reason": "busy" }) };
        core.ui.settings[&key] = coerced;
        save_ui(&state, &core);
        core.ui.settings.clone()
    };
    apply_settings(&app);
    push(&app);
    json!({ "ok": true, "settings": settings })
}

#[tauri::command]
fn reset_settings(app: AppHandle, state: State<AppState>) -> Value {
    let settings = {
        let Ok(mut core) = state.core.lock() else { return json!({ "ok": false, "reason": "busy" }) };
        core.ui.settings = ui::default_settings();
        save_ui(&state, &core);
        core.ui.settings.clone()
    };
    apply_settings(&app);
    push(&app);
    json!({ "ok": true, "settings": settings })
}

#[tauri::command]
fn install_streamdeck(app: AppHandle) -> Value {
    let bundled = bundled_plugin(&app);
    let Some(file) = platform::packed_plugin_path(bundled.clone()) else { return json!({ "ok": false, "reason": "not_packed" }) };
    if platform::stream_deck_status(bundled)["deckInstalled"] != true {
        return json!({ "ok": false, "reason": "no_stream_deck" });
    }
    if platform::open_path(&file) { json!({ "ok": true }) } else { json!({ "ok": false, "reason": "open_failed" }) }
}

/// `gear` is a number or the string `R`; both resolve against the catalogue
/// here, and the only value that can reach settings.json is the `apply` the
/// catalogue itself carries.
#[tauri::command]
fn set_gear(app: AppHandle, state: State<AppState>, provider_id: String, gear: Value) -> Value {
    let result = {
        let Ok(mut core) = state.core.lock() else { return json!({ "ok": false, "reason": "busy" }) };
        let result = gearbox::engage(&mut core.ui.gearbox, &provider_id, &gear);
        if result["ok"] == true {
            save_ui(&state, &core);
        }
        result
    };
    if result["ok"] == true {
        push(&app);
    }
    result
}

pub fn run() {
    let data_dir = paths::app_data_dir();
    let ui_path = data_dir.as_ref().map(|d| d.join("ui.json"));
    let ui_state = UiState::load(ui_path.as_ref());
    // the remembered vendor is mounted even though the app opens locked
    let vendor = ui_state.vendor.clone().filter(|v| v == "openai").unwrap_or_else(|| "anthropic".into());
    let store = UsageStore::new(data_dir.as_ref().map(|d| d.join("state.json")), paths::speedometer_dir().map(|d| d.join("reading.json")));

    tauri::Builder::default()
        // first, so a second launch reaches the running copy before anything else loads
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| reveal_window(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(updater::Slot::default())
        .manage(AppState {
            core: Mutex::new(Core { vendor, scanner: Scanner::default(), store, codex: codex::CodexStore::default(), ui: ui_state, scan: Scan::default() }),
            official: Mutex::new(OfficialProvider::default()),
            bridge: Mutex::new(None),
            tray: Mutex::new(None),
            last_payload: Mutex::new(Value::Null),
            ui_path,
        })
        .invoke_handler(tauri::generate_handler![
            ready, refresh, close, minimize, set_mini, lock, unlock, ui_log,
            set_model, open_vendor, set_setting, reset_settings, install_streamdeck, set_gear
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            // the window: remembered size and place, always on top, every workspace
            if let Some(window) = main_window(&handle) {
                let (size, saved) = state.core.lock().map(|c| (normal_size(&c.ui), (c.ui.x, c.ui.y))).unwrap_or((NORMAL_SIZE, (None, None)));
                let (x, y) = place(&window, saved, size);
                let _ = window.set_size(LogicalSize::new(size.0, size.1));
                let _ = window.set_position(LogicalPosition::new(x, y));
                let _ = window.set_visible_on_all_workspaces(true);
                apply_resize_mode(&window, false);
                let h = handle.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::Moved(pos) => {
                        let st = h.state::<AppState>();
                        let scale = main_window(&h).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
                        if let Ok(mut core) = st.core.lock() {
                            core.ui.x = Some(pos.x as f64 / scale);
                            core.ui.y = Some(pos.y as f64 / scale);
                            save_ui(&st, &core);
                        }
                    }
                    WindowEvent::Resized(size) => {
                        let st = h.state::<AppState>();
                        let Some(w) = main_window(&h) else { return };
                        let scale = w.scale_factor().unwrap_or(1.0);
                        let mini = st.core.lock().map(|c| c.ui.mini).unwrap_or(false);
                        if mini {
                            return;
                        }
                        let width = (size.width as f64 / scale).clamp(NORMAL_SIZE.0 * MIN_SCALE, NORMAL_SIZE.0 * MAX_SCALE).round();
                        let height = (width / ASPECT).round();
                        // the aspect is locked by answering any other shape with this one
                        if (size.height as f64 / scale - height).abs() > 2.0 || (size.width as f64 / scale - width).abs() > 2.0 {
                            let _ = w.set_size(LogicalSize::new(width, height));
                            return;
                        }
                        let _ = w.set_zoom(width / NORMAL_SIZE.0);
                        if let Ok(mut core) = st.core.lock() {
                            if core.ui.width != Some(width) {
                                core.ui.width = Some(width);
                                save_ui(&st, &core);
                            }
                        }
                    }
                    _ => {}
                });
            }
            // the tray, when the platform has one
            let (on_top, to_tray) = state.core.lock().map(|c| (c.ui.flag("alwaysOnTop"), c.ui.flag("minimizeToTray"))).unwrap_or((true, true));
            if let Ok(t) = tray::create(&handle, on_top, to_tray) {
                updater::start(handle.clone(), t.updates.clone());
                if let Ok(mut slot) = state.tray.lock() {
                    *slot = Some(t);
                }
            }
            let menu_app = handle.clone();
            app.on_menu_event(move |_app, event| {
                let st = menu_app.state::<AppState>();
                match event.id().as_ref() {
                    "show" => reveal_window(&menu_app),
                    "pill" => {
                        reveal_window(&menu_app);
                        apply_mini(&menu_app, true);
                    }
                    "refresh" => {
                        let a = menu_app.clone();
                        std::thread::spawn(move || tick(&a, true));
                    }
                    id @ ("alwaysOnTop" | "minimizeToTray") => {
                        let checked = st.tray.lock().ok().and_then(|t| t.as_ref().map(|t| if id == "alwaysOnTop" { t.always_on_top.is_checked() } else { t.minimize_to_tray.is_checked() }.unwrap_or(true)));
                        if let (Some(checked), Ok(mut core)) = (checked, st.core.lock()) {
                            core.ui.settings[id] = json!(checked);
                            save_ui(&st, &core);
                        }
                        apply_settings(&menu_app);
                        push(&menu_app);
                    }
                    "updates" => {
                        let ready = menu_app.state::<updater::Slot>().lock().map(|u| u.ready.is_some()).unwrap_or(false);
                        if ready {
                            updater::install_and_restart(&menu_app);
                        } else if let Some(item) = st.tray.lock().ok().and_then(|t| t.as_ref().map(|t| t.updates.clone())) {
                            let a = menu_app.clone();
                            tauri::async_runtime::spawn(async move { updater::check(&a, &item).await });
                        }
                    }
                    "quit" => {
                        shutdown(&menu_app);
                        menu_app.exit(0);
                    }
                    _ => {}
                }
            });
            apply_settings(&handle);
            let ticker = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(TICK);
                tick(&ticker, false);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building LLM Speedometer")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                shutdown(app);
            }
        });
}
