//! Claude Code's own OAuth token, read from the user's own machine. It leaves
//! the process only in the Authorization header of one request to
//! api.anthropic.com; nothing is logged or persisted.
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

use crate::paths::claude_credentials;

#[derive(Clone, Debug, PartialEq)]
pub struct Creds {
    pub token: String,
    pub expires_at: Option<i64>,
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}
static TOKEN_HINT: OnceLock<Regex> = OnceLock::new();
static REFRESH_HINT: OnceLock<Regex> = OnceLock::new();
static EXPIRY_HINT: OnceLock<Regex> = OnceLock::new();
static OPAQUE: OnceLock<Regex> = OnceLock::new();

fn looks_like_access_token(value: &str) -> bool {
    if value.len() < 40 {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("sk-ant-oat") || lower.starts_with("sk-ant-oauth") {
        return true;
    }
    re(&OPAQUE, r"^[A-Za-z0-9_\-.]{40,}$").is_match(value)
}

struct Found {
    token: Option<String>,
    expires_at: Option<i64>,
    score: i32,
}

/// The schema of the credential file is not contractual and has changed
/// across versions, so the object graph is walked for the most plausible
/// access token rather than read at a fixed key.
fn walk(node: &Value, out: &mut Found, depth: u32) {
    let Some(map) = node.as_object() else { return };
    if depth > 6 {
        return;
    }
    for (key, value) in map {
        if value.is_object() || value.is_array() {
            walk(value, out, depth + 1);
            continue;
        }
        if re(&REFRESH_HINT, "(?i)refresh").is_match(key) {
            continue;
        }
        if re(&EXPIRY_HINT, r"(?i)^(expires_?at|expiry|exp)$").is_match(key) {
            if let Some(n) = value.as_f64() {
                out.expires_at = Some(if n > 1e12 { n as i64 } else { (n * 1000.0) as i64 });
            }
        }
        if let Some(s) = value.as_str() {
            if looks_like_access_token(s) {
                let score = if re(&TOKEN_HINT, r"(?i)^(access_?token|token|bearer)$").is_match(key) {
                    2
                } else if s.to_ascii_lowercase().starts_with("sk-ant-oat") {
                    1
                } else {
                    0
                };
                if score > out.score {
                    out.token = Some(s.to_string());
                    out.score = score;
                }
            }
        }
    }
}

/// The Keychain item also holds MCP servers' tokens (`mcpOAuth`, listed
/// first); Claude's own lives under `claudeAiOauth`, searched alone when there.
pub fn pick_token(parsed: &Value) -> Option<Creds> {
    let root = parsed.get("claudeAiOauth").filter(|v| v.is_object()).unwrap_or(parsed);
    let mut found = Found { token: None, expires_at: None, score: -1 };
    walk(root, &mut found, 0);
    found.token.map(|token| Creds { token, expires_at: found.expires_at })
}

/// macOS keeps the token in the login Keychain rather than in a file.
/// `security find-generic-password` is the supported way to read one's own
/// item; the first call may raise a permission prompt, granted once.
#[cfg(target_os = "macos")]
fn read_keychain() -> Option<String> {
    for service in ["Claude Code-credentials", "Claude Code"] {
        // ponytail: no timeout on the child; `security` answers at once or
        // raises the prompt, and the Node version's 5 s cap never fired.
        let out = std::process::Command::new("security")
            .args(["find-generic-password", "-s", service, "-w"])
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !text.is_empty() {
            return Some(text);
        }
    }
    None
}
#[cfg(not(target_os = "macos"))]
fn read_keychain() -> Option<String> {
    None
}

/// `Ok(None)`: not signed in here. `Err`: a file that exists but cannot be
/// read or parsed, which the caller reports rather than retries every tick.
pub fn read_credentials() -> Result<Option<Creds>, &'static str> {
    let raw = match claude_credentials().map(std::fs::read_to_string) {
        Some(Ok(text)) => text,
        Some(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => match read_keychain() {
            Some(text) => text,
            None => return Ok(None),
        },
        Some(Err(_)) => return Err("credentials_unreadable"),
        None => return Ok(None),
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| "credentials_malformed")?;
    Ok(pick_token(&parsed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOKEN: &str = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";

    #[test]
    fn claudes_own_token_wins_over_an_mcp_servers_listed_first() {
        let item = json!({
            "mcpOAuth": { "figma": { "accessToken": "figd_0123456789abcdefghijklmnopqrstuvwxyz0123456789", "expiresAt": 1.0 } },
            "claudeAiOauth": { "accessToken": TOKEN, "refreshToken": "sk-ant-ort01-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "expiresAt": 1793900000000i64 }
        });
        assert_eq!(pick_token(&item), Some(Creds { token: TOKEN.into(), expires_at: Some(1793900000000) }));
    }

    #[test]
    fn a_flat_file_still_answers_and_seconds_become_milliseconds() {
        let item = json!({ "token": TOKEN, "exp": 1793900000 });
        assert_eq!(pick_token(&item).unwrap().expires_at, Some(1793900000000));
        assert_eq!(pick_token(&json!({ "nothing": "here" })), None);
        assert_eq!(pick_token(&json!({ "accessToken": "short" })), None);
    }
}
