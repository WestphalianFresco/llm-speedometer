//! The few places this app touches the operating system beyond its own
//! files: opening a web page, and finding Elgato's Stream Deck.
use serde_json::{json, Value};
use std::path::PathBuf;

/// The only path from this app to the OS's URL handler. The scheme is
/// checked against a list rather than assumed from where the string came
/// from: the OS will act on file: and any registered protocol.
pub fn open_external(candidate: &str) -> Value {
    let url = candidate.trim();
    let scheme: String = url.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '-' || *c == '.').collect();
    let has_scheme = !scheme.is_empty() && url[scheme.len()..].starts_with(':');
    let well_formed = url.len() < 2048 && !url.chars().any(|c| c.is_control() || c.is_whitespace());
    if !has_scheme || !well_formed {
        return json!({ "ok": false, "reason": "bad_url" });
    }
    if !(scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http")) || !url[scheme.len()..].starts_with("://") {
        return json!({ "ok": false, "reason": "blocked_scheme" });
    }
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).status()
    } else if cfg!(windows) {
        std::process::Command::new("cmd").args(["/C", "start", "", url]).status()
    } else {
        std::process::Command::new("xdg-open").arg(url).status()
    };
    match status {
        Ok(s) if s.success() => json!({ "ok": true, "url": url }),
        _ => json!({ "ok": false, "reason": "open_failed", "url": url }),
    }
}

/// Hand a file to whatever the OS opens it with: a .streamDeckPlugin goes to
/// Stream Deck's own installer, which asks the user before writing anything.
pub fn open_path(path: &std::path::Path) -> bool {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(path).status()
    } else if cfg!(windows) {
        std::process::Command::new("cmd").args(["/C", "start", ""]).arg(path).status()
    } else {
        std::process::Command::new("xdg-open").arg(path).status()
    };
    status.map(|s| s.success()).unwrap_or(false)
}

pub const PLUGIN_UUID: &str = "com.williamfan.llmmeter";
const PACKED_NAME: &str = "com.williamfan.llmmeter.streamDeckPlugin";

fn stream_deck_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        let roaming = std::env::var_os("APPDATA").map(PathBuf::from).or_else(|| crate::paths::home().map(|h| h.join("AppData").join("Roaming")))?;
        Some(roaming.join("Elgato").join("StreamDeck"))
    } else if cfg!(target_os = "macos") {
        Some(crate::paths::home()?.join("Library").join("Application Support").join("com.elgato.StreamDeck"))
    } else {
        None // Elgato ships no Linux build
    }
}

/// The packed plugin: beside the app's resources in an installed build, or
/// under build/ in a checkout once `npm run streamdeck:pack` has run.
pub fn packed_plugin_path(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(r) = resource_dir {
        candidates.push(r.join(PACKED_NAME));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("build").join(PACKED_NAME));
    candidates.into_iter().find(|p| p.is_file())
}

pub fn stream_deck_status(resource_dir: Option<PathBuf>) -> Value {
    let dir = stream_deck_dir();
    let deck_installed = dir.as_ref().map(|d| d.exists()).unwrap_or(false);
    json!({
        "deckInstalled": deck_installed,
        "pluginInstalled": deck_installed && dir.map(|d| d.join("Plugins").join(format!("{PLUGIN_UUID}.sdPlugin")).exists()).unwrap_or(false),
        "canInstall": deck_installed && packed_plugin_path(resource_dir).is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_pages_may_be_opened() {
        assert_eq!(open_external("file:///etc/passwd")["reason"], "blocked_scheme");
        assert_eq!(open_external("javascript:alert(1)")["reason"], "blocked_scheme");
        assert_eq!(open_external("mailto:a@b.c")["reason"], "blocked_scheme");
        assert_eq!(open_external("not a url")["reason"], "bad_url");
        assert_eq!(open_external("https://example.com/a b")["reason"], "bad_url");
    }
}
