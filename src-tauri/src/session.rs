//! The header line-up (what Claude Code itself prints at startup) and the
//! live-session strip, from the transcripts and `~/.claude/sessions/*.json`.
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use crate::local::Last;
use crate::paths::{claude_config, claude_sessions};

const MODEL_NAMES: [(&str, &str); 13] = [
    ("claude-fable-5-1", "Fable 5.1"), ("claude-fable-5", "Fable 5"), ("claude-mythos-5-1", "Mythos 5.1"), ("claude-mythos-5", "Mythos 5"),
    ("claude-opus-5-5", "Opus 5.5"), ("claude-opus-5", "Opus 5"), ("claude-opus-4-8", "Opus 4.8"), ("claude-opus-4-7", "Opus 4.7"),
    ("claude-opus-4-6", "Opus 4.6"), ("claude-sonnet-5-5", "Sonnet 5.5"), ("claude-sonnet-5", "Sonnet 5"), ("claude-sonnet-4-6", "Sonnet 4.6"),
    ("claude-haiku-4-5", "Haiku 4.5"),
];

fn capitalised(word: &str) -> String {
    let mut c = word.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// `claude-opus-5-5` → `Opus 5.5`; an unknown `claude-foo-4-9` → `Foo 4.9`.
pub fn pretty_model(id: &str) -> String {
    let base = id.split('[').next().unwrap_or(id);
    if let Some((_, name)) = MODEL_NAMES.iter().find(|(k, _)| *k == base) {
        return name.to_string();
    }
    let rest = base.strip_prefix("claude-").unwrap_or(base);
    let mut parts = rest.split('-');
    let family = parts.next().unwrap_or(rest);
    // version digits only: a trailing date stamp (20251001) is not a version
    let version: Vec<&str> = parts.take_while(|p| !p.is_empty() && p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit())).collect();
    if version.is_empty() { capitalised(family) } else { format!("{} {}", capitalised(family), version.join(".")) }
}

/// Derived from the model id rather than hardcoded, so the header stays
/// honest if this is ever pointed at a transcript from another provider.
pub fn company_for(id: Option<&str>) -> Option<&'static str> {
    let id = id?;
    let rules: [(&[&str], &str); 7] = [
        (&["claude-"], "Anthropic"),
        (&["gpt-", "o1-", "o3-", "o4-", "chatgpt"], "OpenAI"),
        (&["gemini-"], "Google"),
        (&["llama", "meta-"], "Meta"),
        (&["mistral"], "Mistral"),
        (&["command-"], "Cohere"),
        (&["grok-"], "xAI"),
    ];
    rules.iter().find(|(prefixes, _)| prefixes.iter().any(|p| id.starts_with(p))).map(|(_, name)| *name)
}

/// `default_claude_max_5x` → `Max 5x`.
pub fn pretty_plan(tier: &str) -> String {
    match tier {
        "default_claude_max_5x" => "Max 5x".into(),
        "default_claude_max_20x" => "Max 20x".into(),
        "default_claude_max" => "Max".into(),
        "default_claude_pro" => "Pro".into(),
        "default_claude_team" => "Team".into(),
        "default" => "Free".into(),
        other => other.trim_start_matches("default_").trim_start_matches("claude_").split('_').map(capitalised).collect::<Vec<_>>().join(" "),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Account {
    pub email: Option<String>,
    pub org: Option<String>,
    pub plan: Option<String>,
}

/// The signed-in account from `~/.claude.json`. Cached on the file's mtime:
/// the file is large and the account on it never changes within a session.
pub fn read_account() -> Option<Account> {
    static CACHE: OnceLock<Mutex<(Option<SystemTime>, Option<Account>)>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new((None, None)));
    let path = claude_config()?;
    let mtime = std::fs::metadata(&path).ok()?.modified().ok();
    let mut c = cache.lock().ok()?;
    if mtime.is_some() && c.0 == mtime {
        return c.1.clone();
    }
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    let value = parsed.get("oauthAccount").map(|a| {
        let text = |k: &str| a.get(k).and_then(|v| v.as_str()).map(str::to_string);
        Account { email: text("emailAddress"), org: text("organizationName"), plan: text("organizationRateLimitTier").or_else(|| text("userRateLimitTier")).map(|t| pretty_plan(&t)) }
    });
    *c = (mtime, value.clone());
    value
}

/// Every session file on disk, parsed once.
fn all_sessions() -> Vec<Value> {
    let Some(dir) = claude_sessions() else { return vec![] };
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .collect()
}

fn stamp(s: &Value) -> i64 {
    s.get("updatedAt").or(s.get("startedAt")).and_then(|v| v.as_i64()).unwrap_or(0)
}

/// Version / model / effort / plan / cwd / session name: the freshest
/// transcript says which session is actually working right now.
pub fn read_session(last: &Last, account: Option<&Account>) -> Value {
    let sessions = all_sessions();
    let live = sessions.iter().max_by_key(|s| stamp(s));
    let text = |s: Option<&Value>, k: &str| s.and_then(|s| s.get(k)).and_then(|v| v.as_str()).map(str::to_string);
    let cwd = last.cwd.clone().or_else(|| text(live, "cwd"));
    let name = cwd.as_ref().and_then(|c| sessions.iter().find(|s| s.get("cwd").and_then(|v| v.as_str()) == Some(c))).and_then(|s| text(Some(s), "name")).or_else(|| text(live, "name"));
    json!({
        "version": last.version.clone().or_else(|| text(live, "version")),
        "company": company_for(last.model.as_deref()),
        "modelId": last.model,
        "model": last.model.as_deref().map(pretty_model),
        "effort": last.effort,
        "plan": account.and_then(|a| a.plan.clone()),
        "cwd": cwd,
        "sessionName": name,
    })
}

#[cfg(unix)]
fn is_alive(pid: i64) -> bool {
    if pid <= 0 || pid > i32::MAX as i64 {
        return false;
    }
    // Signal 0 checks for existence; EPERM means it exists under another user.
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
#[cfg(not(unix))]
fn is_alive(pid: i64) -> bool {
    // ponytail: no process probe on Windows yet; a session file is trusted
    // while Claude Code keeps touching it (the caller checks its age).
    pid > 0
}

/// The live sessions, newest first, each with the model its transcript last
/// used (looked up through the scanner, which already read that transcript).
pub fn list_sessions(model_of: &dyn Fn(&str) -> Option<String>, now: i64) -> Vec<Value> {
    let mut out: Vec<Value> = all_sessions()
        .into_iter()
        .filter(|s| {
            let pid = s.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);
            is_alive(pid) && (cfg!(unix) || now - stamp(s) < 2 * 60_000)
        })
        .map(|s| {
            let text = |k: &str| s.get(k).and_then(|v| v.as_str()).map(str::to_string);
            let id = text("sessionId");
            json!({
                "pid": s.get("pid"),
                "sessionId": id,
                "name": text("name"),
                "cwd": text("cwd"),
                "status": text("status"),
                "kind": text("kind"),
                "updatedAt": s.get("updatedAt").or(s.get("startedAt")),
                "startedAt": s.get("startedAt"),
                "model": id.as_deref().and_then(model_of),
            })
        })
        .collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_read_as_the_app_spelled_them() {
        assert_eq!(pretty_plan("default_claude_max_5x"), "Max 5x");
        assert_eq!(pretty_plan("default"), "Free");
        assert_eq!(pretty_plan("default_claude_enterprise_plus"), "Enterprise Plus");
        assert_eq!(pretty_model("claude-opus-5-5"), "Opus 5.5");
        assert_eq!(pretty_model("claude-opus-5-5[1m]"), "Opus 5.5");
        assert_eq!(pretty_model("claude-haiku-4-5-20251001"), "Haiku 4.5");
        assert_eq!(pretty_model("claude-foo-4-9"), "Foo 4.9");
        assert_eq!(pretty_model("gpt-5"), "Gpt 5");
        assert_eq!(company_for(Some("claude-opus-5-5")), Some("Anthropic"));
        assert_eq!(company_for(Some("gpt-5.4")), Some("OpenAI"));
        assert_eq!(company_for(Some("o3-mini")), Some("OpenAI"));
        assert_eq!(company_for(Some("whatever")), None);
        assert_eq!(company_for(None), None);
    }

    #[test]
    fn this_process_is_alive_and_a_dead_pid_is_not() {
        assert!(is_alive(std::process::id() as i64));
        assert!(!is_alive(0));
        assert!(!is_alive(-5));
    }
}
