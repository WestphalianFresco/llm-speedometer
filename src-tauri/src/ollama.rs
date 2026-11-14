//! Local models through Ollama. Ollama keeps no record of tokens: its log has
//! request times only, and the counts exist solely in each reply. So this
//! module is two halves. A relay on a loopback port passes bytes to Ollama
//! and back untouched, reads the token counts off the end of each reply and
//! appends them to `~/.llm-speedometer/ollama.jsonl`; a store then reads that
//! file the way the Codex store reads rollouts. Only traffic sent through the
//! relay is counted: `OLLAMA_HOST=127.0.0.1:11435 ollama run <model>`.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::paths::{ollama_events, ollama_home};
use crate::pricing::{cost_of_tokens, price_meta};

pub const RELAY_PORT: u16 = 11435;
/// The hosted model local tokens are priced against, to say what running
/// them here saved: (id in the price list, name on the page).
/// ponytail: one fixed reference; follow the configured Claude model if the
/// comparison should track what would actually have been used instead.
const REFERENCE: (&str, &str) = ("claude-opus-5-5", "Opus 5.5");
const UPSTREAM_PORT: u16 = 11434;
const RATE_WINDOW_MS: i64 = 10 * 60 * 1000;
const FIVE_HOURS_MS: i64 = 5 * 3600 * 1000;
const SEVEN_DAYS_MS: i64 = 7 * 24 * 3600 * 1000;
/// Requests closer together than this are one sitting: the odometer's trip.
const TRIP_GAP_MS: i64 = 30 * 60 * 1000;
/// A model that answered this recently is busy.
const BUSY_WINDOW_MS: i64 = 90 * 1000;
/// A reply line longer than this is not a token count; drop it unparsed.
const MAX_LINE: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub ts: i64,
    pub model: String,
    pub input: f64,
    pub output: f64,
    /// Time spent generating, for a tokens-per-second reading; 0 when unknown.
    pub eval_ms: f64,
}

// ---------- capture: the relay ----------

/// The token counts off one line of a reply, in either dialect Ollama speaks:
/// its own (`"done":true` closes a reply and carries `eval_count`) or the
/// OpenAI-compatible one (a `usage` block). A reply with no generation in it,
/// such as the empty request that loads a model, yields nothing.
pub fn parse_reply(line: &[u8], now: i64) -> Option<Event> {
    let text = std::str::from_utf8(line).ok()?.trim();
    let text = text.strip_prefix("data:").map(str::trim).unwrap_or(text);
    if !text.starts_with('{') || !(text.contains("\"done\":true") || text.contains("\"usage\"")) {
        return None;
    }
    let v: Value = serde_json::from_str(text).ok()?;
    let model = v["model"].as_str()?.to_string();
    let (input, output, eval_ns) = if v["done"] == true {
        (v["prompt_eval_count"].as_f64().unwrap_or(0.0), v["eval_count"].as_f64()?, v["eval_duration"].as_f64().unwrap_or(0.0))
    } else {
        (v["usage"]["prompt_tokens"].as_f64()?, v["usage"]["completion_tokens"].as_f64()?, 0.0)
    };
    Some(Event { ts: now, model, input, output, eval_ms: eval_ns / 1e6 })
}

/// Feed reply bytes through a line buffer. A streamed reply ends each JSON
/// object with a newline; one sent whole has none, so a pending line that
/// already closes its brace is tried as well.
fn scan(line: &mut Vec<u8>, bytes: &[u8], sink: &dyn Fn(Event)) {
    for &b in bytes {
        if b == b'\n' {
            if let Some(e) = parse_reply(line, crate::now_ms()) {
                sink(e);
            }
            line.clear();
        } else {
            line.push(b);
        }
    }
    if line.last() == Some(&b'}') {
        if let Some(e) = parse_reply(line, crate::now_ms()) {
            sink(e);
            line.clear();
        }
    }
    if line.len() > MAX_LINE {
        line.clear();
    }
}

/// One connection: bytes go both ways unchanged, and the reply side is read
/// for counts on its way past. No HTTP is parsed, so keep-alive, streaming
/// and every route Ollama has or will add pass through as they are.
fn pump(mut client: TcpStream, upstream: SocketAddr, sink: &dyn Fn(Event)) {
    let Ok(mut server) = TcpStream::connect_timeout(&upstream, Duration::from_secs(2)) else {
        let body = r#"{"error":"LLM Speedometer relay: Ollama is not answering on 127.0.0.1:11434"}"#;
        let _ = write!(client, "HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        return;
    };
    let (Ok(mut from_client), Ok(mut to_server)) = (client.try_clone(), server.try_clone()) else { return };
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut from_client, &mut to_server);
        // the client is done sending (or gone): let Ollama see that and stop
        let _ = to_server.shutdown(Shutdown::Write);
    });
    let mut buf = [0u8; 16 * 1024];
    let mut line = Vec::new();
    loop {
        let n = match server.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if client.write_all(&buf[..n]).is_err() {
            break;
        }
        scan(&mut line, &buf[..n], sink);
    }
    let _ = client.shutdown(Shutdown::Both);
    let _ = server.shutdown(Shutdown::Both);
}

/// Serve the relay on a thread of its own, one more thread per connection.
fn relay(listener: TcpListener, upstream: SocketAddr, sink: Arc<dyn Fn(Event) + Send + Sync>) {
    std::thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let sink = sink.clone();
            std::thread::spawn(move || pump(client, upstream, &*sink));
        }
    });
}

fn append(file: &Path, e: &Event) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let line = json!({ "ts": e.ts, "model": e.model, "input": e.input, "output": e.output, "evalMs": e.eval_ms }).to_string() + "\n";
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(file) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Open the relay port. `on_event` runs after each recorded reply, so the
/// gauges move when an answer finishes rather than at the next tick. False
/// when the port is taken: counting stops, the app does not.
pub fn start_relay(on_event: impl Fn() + Send + Sync + 'static) -> bool {
    let Ok(listener) = TcpListener::bind(("127.0.0.1", RELAY_PORT)) else { return false };
    relay(listener, SocketAddr::from(([127, 0, 0, 1], UPSTREAM_PORT)), Arc::new(move |e: Event| {
        if let Some(file) = ollama_events() {
            append(&file, &e);
        }
        on_event();
    }));
    true
}

// ---------- read: the store ----------

#[derive(Default)]
pub struct OllamaStore {
    events: Vec<Event>,
    stamp: Option<(Option<std::time::SystemTime>, u64)>,
    last_scan_at: i64,
}

impl OllamaStore {
    pub fn refresh_local(&mut self, now: i64) {
        if let Some(file) = ollama_events() {
            self.refresh_from(&file, now);
        }
    }

    /// ponytail: the whole file is re-read when it changes, at roughly 90
    /// bytes a request. Track an offset if it ever reaches tens of MB.
    pub fn refresh_from(&mut self, file: &Path, now: i64) {
        self.last_scan_at = now;
        let stamp = std::fs::metadata(file).ok().map(|m| (m.modified().ok(), m.len()));
        if stamp == self.stamp {
            return;
        }
        self.stamp = stamp;
        self.events = std::fs::read_to_string(file).unwrap_or_default().lines().filter_map(|l| {
            let v: Value = serde_json::from_str(l).ok()?;
            Some(Event {
                ts: v["ts"].as_i64()?,
                model: v["model"].as_str()?.to_string(),
                input: v["input"].as_f64().unwrap_or(0.0),
                output: v["output"].as_f64().unwrap_or(0.0),
                eval_ms: v["evalMs"].as_f64().unwrap_or(0.0),
            })
        }).collect();
        self.events.sort_by_key(|e| e.ts);
    }

    /// Tokens, requests and the reference model's list price for them inside
    /// a window. Tokens are fed plus produced, the odometer's definition;
    /// `+ 0.0` keeps an empty sum from printing as "-0".
    fn tally(&self, from: i64, to: i64) -> (f64, usize, f64) {
        let inside = || self.events.iter().filter(move |e| e.ts >= from && e.ts <= to);
        let (input, output) = inside().fold((0.0, 0.0), |a, e| (a.0 + e.input, a.1 + e.output));
        (input + output + 0.0, inside().count(), cost_of_tokens(input, output, 0.0, 0.0, REFERENCE.0, "anthropic"))
    }

    /// The latest run of requests with no long gap between them.
    fn trip(&self) -> (f64, usize) {
        let mut tokens = 0.0;
        let mut turns = 0;
        let mut later: Option<i64> = None;
        for e in self.events.iter().rev() {
            if later.is_some_and(|l| l - e.ts > TRIP_GAP_MS) {
                break;
            }
            tokens += e.input + e.output;
            turns += 1;
            later = Some(e.ts);
        }
        (tokens, turns)
    }

    /// One row per model, newest first: the nearest thing a local model has
    /// to a session.
    fn models(&self, now: i64) -> Vec<Value> {
        let mut seen: Vec<(&str, i64, i64)> = Vec::new(); // model, first, last
        for e in &self.events {
            match seen.iter_mut().find(|s| s.0 == e.model) {
                Some(s) => s.2 = e.ts,
                None => seen.push((e.model.as_str(), e.ts, e.ts)),
            }
        }
        seen.sort_by_key(|s| -s.2);
        seen.iter().map(|(model, first, last)| json!({
            "pid": null, "sessionId": model, "name": model, "cwd": null,
            "status": if now - last < BUSY_WINDOW_MS { "busy" } else { "idle" },
            "kind": "cli", "updatedAt": last, "startedAt": first, "model": model,
        })).collect()
    }

    /// The payload's vendor half, in the shape the Codex store returns. A
    /// local model has no quota and no bill: both tanks read N/A, and the
    /// plan is named so the page shows no per-token cost.
    pub fn read(&self, now: i64) -> Value {
        let window = |label: &str| json!({ "percent": null, "source": "unsupported", "confidence": "unknown", "resetsAt": null, "anchorAt": null, "label": label });
        let budget = |span: i64| {
            let (tokens, turns, _) = self.tally(now - span, now);
            let oldest = self.events.first().map(|e| e.ts).unwrap_or(now);
            let covered = ((now - oldest.max(now - span)) as f64 / span as f64).clamp(0.0, 1.0);
            json!({ "windowStart": now - span, "resetsAt": null, "usedTokens": tokens, "usedCost": 0.0, "turns": turns, "covered": covered,
                    "capacityTokens": null, "remainingTokens": null, "confidence": "unknown" })
        };
        let (total, turns, saved_lifetime) = self.tally(0, now);
        let saved = json!({ "fiveHour": self.tally(now - FIVE_HOURS_MS, now).2, "sevenDay": self.tally(now - SEVEN_DAYS_MS, now).2, "lifetime": saved_lifetime,
                            "against": REFERENCE.1, "pricing": price_meta("anthropic") });
        let (trip, trip_turns) = self.trip();
        let last = self.events.last();
        let model = last.map(|e| e.model.clone());
        let since = now - RATE_WINDOW_MS;
        let recent_output: f64 = self.events.iter().filter(|e| e.ts >= since && e.ts <= now).map(|e| e.output).sum::<f64>() + 0.0;
        let odo = json!({ "total": total, "turns": turns, "files": if self.stamp.is_some_and(|s| s.1 > 0) { 1 } else { 0 },
                          "trip": trip, "tripTurns": trip_turns, "tripSessionId": model });
        json!({
            "at": now,
            "vendorId": "ollama",
            "fiveHour": window("5-hour"),
            "sevenDay": window("This week"),
            "weeklyScoped": null,
            "spend": { "fiveHour": 0.0, "sevenDay": 0.0 },
            "quotaRate": { "fiveHour": null, "sevenDay": null },
            "budget": { "fiveHour": budget(FIVE_HOURS_MS), "sevenDay": budget(SEVEN_DAYS_MS), "lifetime": { "usedTokens": total, "turns": turns } },
            // nothing is billed; `saved` is what the same tokens list for at the reference model
            "cost": { "fiveHour": 0.0, "sevenDay": 0.0, "lifetime": 0.0, "official": null, "plan": "Local", "pricing": null, "saved": saved },
            "tokensPerMinute": recent_output / (RATE_WINDOW_MS as f64 / 60_000.0),
            // how fast the last answer was generated
            "tokensPerSecond": last.filter(|e| e.eval_ms > 0.0).map(|e| e.output / (e.eval_ms / 1000.0)),
            "calibrated": false,
            "official": { "lastAttempt": { "at": self.last_scan_at, "status": "no_data" }, "nextPollAt": 0, "backingOff": false,
                          "reason": "local models have no quota to report" },
            "localEvents": turns,
            "account": { "email": null, "org": null },
            "session": { "version": null, "company": "Ollama", "modelId": model, "model": model, "effort": null, "plan": "Local", "cwd": null, "sessionName": null },
            "configuredModel": model,
            "configuredModelValue": model,
            "configuredModelFamily": null,
            "modelOptions": [],
            "liveSessions": self.models(now),
            "odometer": odo,
        })
    }
}

/// Is Ollama on this machine? It is usable before anything is recorded: the
/// dashboard opens on zeros and says how to send a chat through the relay.
pub fn detect() -> Value {
    let installed = ollama_home().map(|h| h.exists()).unwrap_or(false);
    let has_data = ollama_events().and_then(|f| std::fs::metadata(f).ok()).map(|m| m.len() > 0).unwrap_or(false);
    let note = if !installed {
        "Ollama not found on this device. Install it from ollama.com and pull a model.".to_string()
    } else {
        format!("Only chats sent through port {RELAY_PORT} are counted: OLLAMA_HOST=127.0.0.1:{RELAY_PORT} ollama run <model>")
    };
    json!({ "present": installed, "usable": installed, "dataAvailable": has_data, "account": null, "note": note })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const NOW: i64 = 1_794_700_000_000;

    #[test]
    fn a_reply_line_yields_its_counts_in_either_dialect() {
        let native = br#"{"model":"qwen3.6:35b","created_at":"2026-11-14T19:17:28Z","response":"","done":true,"done_reason":"stop","prompt_eval_count":21,"eval_count":926,"eval_duration":11589587417}"#;
        let e = parse_reply(native, NOW).unwrap();
        assert_eq!((e.model.as_str(), e.input, e.output, e.ts), ("qwen3.6:35b", 21.0, 926.0, NOW));
        assert!((e.eval_ms - 11589.587417).abs() < 1e-6);
        let openai = br#"data: {"id":"x","model":"gpt-oss:20b","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}"#;
        let e = parse_reply(openai, NOW).unwrap();
        assert_eq!((e.model.as_str(), e.input, e.output), ("gpt-oss:20b", 12.0, 34.0));
        // a token mid-stream, the request that only loads a model, a null usage block, a header
        assert!(parse_reply(br#"{"model":"m","response":"hi","done":false}"#, NOW).is_none());
        assert!(parse_reply(br#"{"model":"m","response":"","done":true,"done_reason":"load"}"#, NOW).is_none());
        assert!(parse_reply(br#"data: {"model":"m","choices":[{}],"usage":null}"#, NOW).is_none());
        assert!(parse_reply(b"HTTP/1.1 200 OK\r", NOW).is_none());
        // text that merely quotes the marker is escaped inside its string, so it is not one
        assert!(parse_reply(br#"{"model":"m","response":"say \"done\":true","done":false}"#, NOW).is_none());
    }

    #[test]
    fn the_relay_passes_bytes_through_and_records_each_reply() {
        // a stand-in for Ollama: one streamed reply, then one sent whole, on a kept-alive connection
        let fake = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = fake.local_addr().unwrap();
        let chunk = |json: &str| format!("{:x}\r\n{json}\n\r\n", json.len() + 1);
        let streamed = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{}{}0\r\n\r\n",
            chunk(r#"{"model":"m1","response":"hi","done":false}"#),
            chunk(r#"{"model":"m1","done":true,"prompt_eval_count":5,"eval_count":7,"eval_duration":1}"#));
        let body = r#"{"model":"m2","done":true,"prompt_eval_count":3,"eval_count":4}"#;
        let whole = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        let reply = format!("{streamed}{whole}");
        let sent = reply.clone();
        std::thread::spawn(move || {
            let (mut s, _) = fake.accept().unwrap();
            let mut request = [0u8; 64];
            let n = s.read(&mut request).unwrap();
            assert_eq!(&request[..n], b"POST /api/chat HTTP/1.1\r\n\r\n");
            // split mid-object, so the line buffer has to join two reads
            let (a, b) = sent.as_bytes().split_at(90);
            s.write_all(a).unwrap();
            std::thread::sleep(Duration::from_millis(30));
            s.write_all(b).unwrap();
        });
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        relay(listener, upstream, Arc::new(move |e: Event| seen2.lock().unwrap().push(e)));

        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.write_all(b"POST /api/chat HTTP/1.1\r\n\r\n").unwrap();
        let mut got = String::new();
        client.read_to_string(&mut got).unwrap();
        assert_eq!(got, reply, "the client sees exactly what Ollama sent");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.iter().map(|e| (e.model.as_str(), e.input, e.output)).collect::<Vec<_>>(), vec![("m1", 5.0, 7.0), ("m2", 3.0, 4.0)]);
    }

    #[test]
    fn a_relay_with_no_ollama_behind_it_says_so() {
        // a port nothing listens on: bound to learn a free number, then dropped
        let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        relay(listener, dead, Arc::new(|_: Event| {}));
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut got = String::new();
        client.read_to_string(&mut got).unwrap();
        assert!(got.starts_with("HTTP/1.1 502") && got.contains("Ollama is not answering"));
    }

    #[test]
    fn the_store_tallies_the_file_and_reads_no_quota() {
        let dir = std::env::temp_dir().join(format!("speedo-ollama-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("ollama.jsonl");
        let _ = std::fs::remove_file(&file);
        let min = 60_000;
        // an old sitting two hours back, then two requests in the last ten minutes
        append(&file, &Event { ts: NOW - 120 * min, model: "gpt-oss:20b".into(), input: 100.0, output: 50.0, eval_ms: 1000.0 });
        append(&file, &Event { ts: NOW - 5 * min, model: "qwen3.6:35b".into(), input: 20.0, output: 300.0, eval_ms: 5000.0 });
        append(&file, &Event { ts: NOW - min, model: "qwen3.6:35b".into(), input: 30.0, output: 800.0, eval_ms: 10_000.0 });
        std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(b"not json\n").unwrap();

        let mut s = OllamaStore::default();
        s.refresh_from(&file, NOW);
        let r = s.read(NOW);
        assert_eq!((r["odometer"]["total"].as_f64(), r["odometer"]["turns"].as_i64()), (Some(1300.0), Some(3)));
        assert_eq!((r["odometer"]["trip"].as_f64(), r["odometer"]["tripTurns"].as_i64()), (Some(1150.0), Some(2)), "the old sitting is not this trip");
        assert_eq!(r["tokensPerMinute"], 110.0, "1100 output tokens over the ten-minute window");
        assert_eq!(r["tokensPerSecond"], 80.0);
        assert_eq!((r["fiveHour"]["source"].as_str(), r["sevenDay"]["percent"].is_null()), (Some("unsupported"), true));
        assert_eq!(r["budget"]["fiveHour"]["usedTokens"], 1300.0);
        assert_eq!((r["cost"]["plan"].as_str(), r["cost"]["sevenDay"].as_f64()), (Some("Local"), Some(0.0)));
        // 150 in and 1150 out at Opus 5.5's $4 / $20 per million
        assert!((r["cost"]["saved"]["sevenDay"].as_f64().unwrap() - (150.0 * 4.0 + 1150.0 * 20.0) / 1e6).abs() < 1e-12);
        assert_eq!(r["cost"]["saved"]["against"], "Opus 5.5");
        assert_eq!((r["session"]["model"].as_str(), r["session"]["company"].as_str()), (Some("qwen3.6:35b"), Some("Ollama")));
        assert_eq!((r["liveSessions"][0]["name"].as_str(), r["liveSessions"][0]["status"].as_str()), (Some("qwen3.6:35b"), Some("busy")));
        assert_eq!((r["liveSessions"][1]["name"].as_str(), r["liveSessions"][1]["status"].as_str()), (Some("gpt-oss:20b"), Some("idle")));
        // nothing recorded yet reads as zeros, not as a failure
        let empty = OllamaStore::default().read(NOW);
        assert_eq!((empty["odometer"]["total"].as_f64(), empty["tokensPerMinute"].as_f64(), empty["tokensPerSecond"].is_null()), (Some(0.0), Some(0.0), true));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
