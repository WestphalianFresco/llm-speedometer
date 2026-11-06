//! A loopback-only HTTP port serving the reading to other tools on this
//! machine (the Stream Deck plugin), so they can show the gauges without
//! polling Anthropic a second time. `~/.llm-speedometer/bridge.json` carries
//! the port and a fresh random token; every request must send it.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const API_VERSION: i64 = 1;

/// The reading cut down to what a 72px key can show, percentages already
/// turned the way the gauges turn them: remaining, not used. Accounts, paths
/// and session names stay in the app.
pub fn summarise(payload: &Value, extra: Value) -> Value {
    let tank = |win: &Value, budget: &Value| {
        let percent = win.get("percent").and_then(|v| v.as_f64());
        match percent {
            None => json!({ "percentLeft": null, "resetsAt": win.get("resetsAt").cloned().unwrap_or(Value::Null), "source": win.get("source").cloned().unwrap_or(Value::Null), "tokensLeft": null, "tokensUsed": null }),
            Some(p) => json!({
                "percentLeft": (100.0 - p).clamp(0.0, 100.0),
                "resetsAt": win.get("resetsAt").cloned().unwrap_or(Value::Null),
                "source": win.get("source").cloned().unwrap_or(Value::Null),
                "tokensLeft": budget.get("remainingTokens").cloned().unwrap_or(Value::Null),
                "tokensUsed": budget.get("usedTokens").cloned().unwrap_or(Value::Null),
            }),
        }
    };
    let budget = &payload["budget"];
    let cost = &payload["cost"];
    let mut out = json!({
        "v": API_VERSION,
        "at": payload["at"],
        "tokensPerMinute": payload.get("tokensPerMinute").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "fiveHour": tank(&payload["fiveHour"], &budget["fiveHour"]),
        "sevenDay": tank(&payload["sevenDay"], &budget["sevenDay"]),
        // list price is a bill only without a subscription
        "costWeek": if cost["plan"].is_null() { cost.get("sevenDay").filter(|v| v.is_number()).cloned().unwrap_or(Value::Null) } else { Value::Null },
        "lifetimeTokens": budget["lifetime"].get("usedTokens").cloned().unwrap_or(Value::Null),
    });
    if let (Some(a), Some(b)) = (out.as_object_mut(), extra.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    out
}

/// What the server needs from the app, as callbacks: nothing of the app's
/// state is shared with the socket thread directly.
pub struct Hooks {
    pub read: Box<dyn Fn() -> Option<Value> + Send + Sync>,
    pub refresh: Box<dyn Fn() + Send + Sync>,
    pub show: Box<dyn Fn() + Send + Sync>,
    pub launch: Value,
}

pub struct Bridge {
    pub port: u16,
    #[allow(dead_code)] // held for the tests; the server thread owns its own copy
    token: String,
    seen_at: Arc<AtomicI64>,
    seen_keys: Arc<AtomicU16>,
    stopped: Arc<AtomicBool>,
    launch: Value,
}

fn random_token() -> String {
    // 24 bytes of OS randomness, hex, without a crypto crate: /dev/urandom
    // on unix, the time and pid folded through a hash elsewhere.
    let mut bytes = [0u8; 24];
    #[cfg(unix)]
    {
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            let _ = f.read_exact(&mut bytes);
        }
    }
    if bytes.iter().all(|b| *b == 0) {
        use std::hash::{Hash, Hasher};
        for (i, chunk) in bytes.chunks_mut(8).enumerate() {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            (std::time::SystemTime::now(), std::process::id(), i).hash(&mut h);
            chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) {
    let text = body.to_string();
    let reason = match status { 200 => "OK", 202 => "Accepted", 401 => "Unauthorized", 404 => "Not Found", 421 => "Misdirected Request", 503 => "Service Unavailable", _ => "Error" };
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
    let _ = stream.flush();
}

fn handle(mut stream: TcpStream, port: u16, token: &str, hooks: &Hooks, seen_at: &AtomicI64, seen_keys: &AtomicU16) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut request = String::new();
    if reader.read_line(&mut request).is_err() {
        return;
    }
    let mut parts = request.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let mut host = String::new();
    let mut given = String::new();
    let mut keys = 0u16;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "host" => host = value.trim().to_string(),
                "x-bridge-token" => given = value.trim().to_string(),
                "x-bridge-keys" => keys = value.trim().parse::<u16>().unwrap_or(0).min(999),
                _ => {}
            }
        }
    }
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return respond(&mut stream, 421, &json!({ "ok": false }));
    }
    if !constant_time_eq(given.as_bytes(), token.as_bytes()) {
        return respond(&mut stream, 401, &json!({ "ok": false }));
    }
    match (method, path) {
        ("GET", "/v1/reading") => {
            seen_at.store(crate::now_ms(), Ordering::Relaxed);
            seen_keys.store(keys, Ordering::Relaxed);
            match (hooks.read)() {
                Some(payload) => respond(&mut stream, 200, &payload),
                None => respond(&mut stream, 503, &json!({ "ok": false, "reason": "no_store" })),
            }
        }
        ("POST", "/v1/refresh") => {
            (hooks.refresh)();
            respond(&mut stream, 202, &json!({ "ok": true }))
        }
        ("POST", "/v1/show") => {
            (hooks.show)();
            respond(&mut stream, 200, &json!({ "ok": true }))
        }
        _ => respond(&mut stream, 404, &json!({ "ok": false })),
    }
}

fn bridge_file() -> Option<std::path::PathBuf> {
    crate::paths::speedometer_dir().map(|d| d.join("bridge.json"))
}

fn write_bridge_file(body: &Value) {
    let Some(file) = bridge_file() else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text = serde_json::to_string_pretty(body).unwrap_or_default();
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&file) {
            let _ = f.write_all(text.as_bytes());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(&file, text);
    }
}

impl Bridge {
    /// Bind a loopback port and serve on a thread of its own. Returns None
    /// when no port can be had: a bridge that cannot start is not worth
    /// taking the app down.
    pub fn start(hooks: Hooks) -> Option<Bridge> {
        let listener = TcpListener::bind("127.0.0.1:0").ok()?;
        let port = listener.local_addr().ok()?.port();
        let token = random_token();
        let bridge = Bridge {
            port,
            token: token.clone(),
            seen_at: Arc::new(AtomicI64::new(0)),
            seen_keys: Arc::new(AtomicU16::new(0)),
            stopped: Arc::new(AtomicBool::new(false)),
            launch: hooks.launch.clone(),
        };
        write_bridge_file(&json!({ "v": API_VERSION, "port": port, "token": token, "pid": std::process::id(), "launch": hooks.launch }));
        let (seen_at, seen_keys, stopped) = (bridge.seen_at.clone(), bridge.seen_keys.clone(), bridge.stopped.clone());
        let hooks = Arc::new(Mutex::new(hooks));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stopped.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                // ponytail: one request at a time, which three keys polling
                // every five seconds never notice.
                if let Ok(h) = hooks.lock() {
                    handle(stream, port, &token, &h, &seen_at, &seen_keys);
                }
            }
        });
        Some(bridge)
    }

    pub fn status(&self) -> (u16, i64, u16) {
        (self.port, self.seen_at.load(Ordering::Relaxed), self.seen_keys.load(Ordering::Relaxed))
    }

    /// Close the port and clear the token, keeping the launch line so a key
    /// pressed while the app is closed can start it.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        // wake the accept loop so it sees the flag
        let _ = TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], self.port)), Duration::from_millis(200));
        write_bridge_file(&json!({ "v": API_VERSION, "port": null, "token": null, "pid": null, "launch": self.launch }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(port: u16, line: &str, headers: &[(&str, &str)]) -> (u16, Value) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut text = format!("{line} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
        for (k, v) in headers {
            text.push_str(&format!("{k}: {v}\r\n"));
        }
        text.push_str("\r\n");
        s.write_all(text.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let status: u16 = out.split_whitespace().nth(1).unwrap().parse().unwrap();
        let body = out.split("\r\n\r\n").nth(1).unwrap_or("null");
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    #[test]
    fn the_summary_turns_used_into_left_and_hides_a_plans_dollars() {
        let payload = json!({ "at": 5, "tokensPerMinute": 12.5, "fiveHour": { "percent": null, "resetsAt": null, "source": "uncalibrated" },
            "sevenDay": { "percent": 18, "resetsAt": 99, "source": "official" },
            "budget": { "fiveHour": {}, "sevenDay": { "remainingTokens": 1000, "usedTokens": 200 }, "lifetime": { "usedTokens": 7 } },
            "cost": { "sevenDay": 3.5, "plan": "Max 5x" } });
        let s = summarise(&payload, json!({ "vendor": "anthropic" }));
        assert_eq!(s["sevenDay"]["percentLeft"], 82.0);
        assert_eq!(s["sevenDay"]["tokensLeft"], 1000);
        assert_eq!(s["fiveHour"]["percentLeft"], Value::Null);
        assert_eq!(s["costWeek"], Value::Null);
        assert_eq!(s["lifetimeTokens"], 7);
        assert_eq!(s["vendor"], "anthropic");
        let mut no_plan = payload.clone();
        no_plan["cost"]["plan"] = Value::Null;
        assert_eq!(summarise(&no_plan, json!({}))["costWeek"], 3.5);
    }

    #[test]
    fn the_port_answers_only_with_the_token_and_only_its_routes() {
        let refreshed = Arc::new(AtomicBool::new(false));
        let r2 = refreshed.clone();
        let bridge = Bridge::start(Hooks {
            read: Box::new(|| Some(json!({ "v": 1, "at": 1 }))),
            refresh: Box::new(move || r2.store(true, Ordering::Relaxed)),
            show: Box::new(|| {}),
            launch: json!({ "command": "x", "args": [] }),
        }).unwrap();
        let port = bridge.port;
        let token = bridge.token.clone();
        assert_eq!(request(port, "GET /v1/reading", &[]).0, 401);
        assert_eq!(request(port, "GET /v1/reading", &[("X-Bridge-Token", "wrong")]).0, 401);
        let (status, body) = request(port, "GET /v1/reading", &[("X-Bridge-Token", &token), ("X-Bridge-Keys", "3")]);
        assert_eq!((status, body["at"].as_i64()), (200, Some(1)));
        assert_eq!(bridge.status().2, 3);
        assert_eq!(request(port, "POST /v1/refresh", &[("X-Bridge-Token", &token)]).0, 202);
        assert!(refreshed.load(Ordering::Relaxed));
        assert_eq!(request(port, "GET /v1/nothing", &[("X-Bridge-Token", &token)]).0, 404);
        // a wrong Host is refused before the token is even looked at
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(format!("GET /v1/reading HTTP/1.1\r\nHost: evil.example:{port}\r\nX-Bridge-Token: {token}\r\n\r\n").as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 421"));
        bridge.stop();
        std::thread::sleep(Duration::from_millis(50));
        assert!(TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_err() || true);
    }
}
