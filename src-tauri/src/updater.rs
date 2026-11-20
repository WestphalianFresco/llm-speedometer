//! Self-update from GitHub Releases. The release workflow signs each bundle
//! and publishes `latest.json`; the installed app checks it on start and
//! every four hours, downloads anything newer in the background, and then
//! offers "Restart to update" in the tray rather than restarting a gauge
//! mid-glance. Nothing installs until that item is clicked.
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);

pub struct Ready {
    pub version: String,
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct Updater {
    pub ready: Option<Ready>,
    pub checking: bool,
    pub last_error: Option<String>,
}

pub type Slot = Mutex<Updater>;

/// The tray item's label for the state: what it offers, or what it last did.
pub fn label(u: &Updater) -> String {
    if let Some(r) = &u.ready {
        format!("Restart to update ({})", r.version)
    } else if u.checking {
        "Checking for updates…".into()
    } else if let Some(e) = &u.last_error {
        format!("Check for updates (last: {})", e.chars().take(40).collect::<String>())
    } else {
        "Check for updates".into()
    }
}

pub async fn check(app: &AppHandle, item: &MenuItem<tauri::Wry>) {
    let slot = app.state::<Slot>();
    if let Ok(mut u) = slot.lock() {
        if u.ready.is_some() || u.checking {
            return;
        }
        u.checking = true;
        let _ = item.set_text(label(&u));
    }
    let outcome: Result<Option<Ready>, String> = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(None) };
        let version = update.version.clone();
        let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        Ok(Some(Ready { version, update, bytes }))
    }
    .await;
    if let Ok(mut u) = slot.lock() {
        u.checking = false;
        match outcome {
            Ok(ready) => {
                u.last_error = None;
                u.ready = ready;
            }
            // offline, or GitHub having a moment: the next check tries again
            Err(e) => u.last_error = Some(e),
        }
        let _ = item.set_text(label(&u));
    }
}

/// Install what was downloaded and restart into it. Nothing happens unless
/// a download is ready, so the item is safe to click at any time.
pub fn install_and_restart(app: &AppHandle) {
    let slot = app.state::<Slot>();
    let ready = slot.lock().ok().and_then(|mut u| u.ready.take());
    let Some(ready) = ready else { return };
    crate::shutdown(app);
    if ready.update.install(ready.bytes).is_ok() {
        app.restart();
    }
}

/// The first check after startup has settled, then one every four hours.
pub fn start(app: AppHandle, item: MenuItem<tauri::Wry>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check(&app, &item).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tray_item_says_what_the_updater_is_doing() {
        let mut u = Updater::default();
        assert_eq!(label(&u), "Check for updates");
        u.checking = true;
        assert_eq!(label(&u), "Checking for updates…");
        u.checking = false;
        u.last_error = Some("Could not resolve host: github.com and then some more words".into());
        let l = label(&u);
        assert!(l.starts_with("Check for updates (last: Could not resolve host"), "{l}");
        assert!(l.len() <= "Check for updates (last: )".len() + 40, "{l}");
    }
}
