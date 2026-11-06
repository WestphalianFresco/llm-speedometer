//! Where each CLI keeps its files. No path is hardcoded: an environment
//! override is authoritative when set, then the conventional dot-directory,
//! then `$XDG_CONFIG_HOME/<tool>`. Resolved per call, so a CLI signed into
//! after this app started is picked up without a restart.
use std::path::PathBuf;

pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn xdg_config() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".config")))
}

fn resolve_root(override_: Option<PathBuf>, candidates: Vec<Option<PathBuf>>) -> Option<PathBuf> {
    if override_.is_some() {
        return override_;
    }
    let real: Vec<PathBuf> = candidates.into_iter().flatten().collect();
    real.iter().find(|c| c.exists()).cloned().or_else(|| real.first().cloned())
}

pub fn claude_home() -> Option<PathBuf> {
    resolve_root(
        std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
        vec![home().map(|h| h.join(".claude")), xdg_config().map(|x| x.join("claude"))],
    )
}
pub fn claude_projects() -> Option<PathBuf> { claude_home().map(|h| h.join("projects")) }
pub fn claude_sessions() -> Option<PathBuf> { claude_home().map(|h| h.join("sessions")) }
pub fn claude_settings() -> Option<PathBuf> { claude_home().map(|h| h.join("settings.json")) }
pub fn claude_credentials() -> Option<PathBuf> { claude_home().map(|h| h.join(".credentials.json")) }

pub fn claude_config() -> Option<PathBuf> {
    resolve_root(
        std::env::var_os("CLAUDE_CONFIG_DIR").map(|d| PathBuf::from(d).join(".claude.json")),
        vec![home().map(|h| h.join(".claude.json")), xdg_config().map(|x| x.join("claude").join("claude.json"))],
    )
}

pub fn codex_home() -> Option<PathBuf> {
    resolve_root(
        std::env::var_os("CODEX_HOME").map(PathBuf::from),
        vec![home().map(|h| h.join(".codex")), xdg_config().map(|x| x.join("codex"))],
    )
}
pub fn codex_sessions() -> Option<PathBuf> { codex_home().map(|h| h.join("sessions")) }
pub fn codex_auth() -> Option<PathBuf> { codex_home().map(|h| h.join("auth.json")) }

/// `~/.llm-speedometer`: the bridge file, the plugin's reading, price overrides.
pub fn speedometer_dir() -> Option<PathBuf> { home().map(|h| h.join(".llm-speedometer")) }

/// Where the Electron build kept its state, so the learned calibration carries
/// over instead of starting from nothing.
pub fn app_data_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        home().map(|h| h.join("Library").join("Application Support").join("LLM Speedometer"))
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("LLM Speedometer"))
    } else {
        xdg_config().map(|x| x.join("LLM Speedometer"))
    }
}
