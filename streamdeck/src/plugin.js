import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import streamDeck, { SingletonAction } from "@elgato/streamdeck";

// The app, not this plugin, owns the transcripts and the rate-limited usage endpoint.
// It publishes a loopback port and token here; everything below reads through that.
const BRIDGE_FILE = join(homedir(), ".llm-speedometer", "bridge.json");
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 2_000;
const FONT = "Segoe UI, Arial";
// Same full scale as the app's tachometer, so the key and the dial agree on "flat out".
const RATE_MAX = 20_000;

// Gauge geometry: a 270-degree arc open at the bottom, centred on the key (as in sysmon).
const CX = 72;
const CY = 70;
const R = 52;
const STROKE = 13;
const SWEEP = 270;
const START_ANGLE = 135;

// A tank reads remaining, so it goes red as it empties — the opposite of a load gauge.
function tankColor(pctLeft) {
	if (pctLeft <= 15) return "#ff5c5c";
	if (pctLeft <= 40) return "#f5b940";
	return "#3ecf7a";
}

function rateColor(rate) {
	if (rate >= RATE_MAX * 0.75) return "#ff5c5c";
	if (rate >= RATE_MAX * 0.4) return "#f5b940";
	return "#4aa8ff";
}

function polar(angle) {
	const rad = (angle * Math.PI) / 180;
	return [CX + R * Math.cos(rad), CY + R * Math.sin(rad)];
}

function arcPath(fromAngle, sweep) {
	const [x1, y1] = polar(fromAngle);
	const [x2, y2] = polar(fromAngle + sweep);
	return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${sweep > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Ring gauge: `fill` is 0..1 of the arc, `number` the big readout, `unit` its small suffix. */
function renderGauge({ label, fill, color, number, unit = "", detail }) {
	const sweep = Math.max(0.5, Math.min(1, fill ?? 0) * SWEEP);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#12171d"/>
<path d="${arcPath(START_ANGLE, SWEEP)}" fill="none" stroke="#2a323c" stroke-width="${STROKE}" stroke-linecap="round"/>
${fill == null ? "" : `<path d="${arcPath(START_ANGLE, sweep)}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>`}
<text x="${CX}" y="50" font-family="${FONT}" font-size="15" font-weight="700" fill="#8b98a5" text-anchor="middle" letter-spacing="1">${label}</text>
<text x="${CX}" y="89" font-family="${FONT}" font-size="${number.length > 4 ? 32 : 40}" font-weight="700" fill="#ffffff" text-anchor="middle">${number}<tspan font-size="18" fill="#c9d1d9">${unit}</tspan></text>
<text x="${CX}" y="134" font-family="${FONT}" font-size="15" font-weight="600" fill="#c9d1d9" text-anchor="middle">${detail}</text>
</svg>`;
	return "data:image/svg+xml," + encodeURIComponent(svg);
}

function formatTokens(n) {
	if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
	if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
	return String(Math.round(n));
}

function formatCountdown(resetsAt) {
	if (!resetsAt) return "";
	const mins = Math.max(0, Math.round((resetsAt - Date.now()) / 60_000));
	const d = Math.floor(mins / 1440);
	const h = Math.floor((mins % 1440) / 60);
	const m = mins % 60;
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

// ---------- bridge client ----------

/** Re-read every time: the app picks a new port and token on each launch. */
async function readBridgeFile() {
	try {
		return JSON.parse(await readFile(BRIDGE_FILE, "utf8"));
	} catch {
		return null;
	}
}

async function call(method, path, keys = 0) {
	const bridge = await readBridgeFile();
	if (!bridge?.port || !bridge?.token) return null;
	try {
		const res = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
			method,
			// The key count is only for the app's settings panel, which reports how many keys are reading it.
			headers: { "X-Bridge-Token": bridge.token, "X-Bridge-Keys": String(keys) },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		return res.ok ? await res.json() : null;
	} catch {
		return null; // app closed, or it crashed and left a stale file behind
	}
}

/** Start the app from the launch line it left behind. Only ever runs on a key press. */
async function launchApp() {
	const bridge = await readBridgeFile();
	const launch = bridge?.launch;
	if (!launch?.command || !Array.isArray(launch.args)) {
		streamDeck.logger.warn("no launch line in bridge.json; start LLM Speedometer once by hand");
		return false;
	}
	spawn(launch.command, launch.args, { detached: true, stdio: "ignore" }).unref();
	return true;
}

/**
 * One poller shared by every key: however many are on the deck, the app is asked once
 * per interval. It runs only while at least one key is visible.
 */
const poller = {
	actions: new Set(),
	timer: null,
	reading: null,

	subscribe(action) {
		this.actions.add(action);
		if (!this.timer) {
			this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
			this.poll();
		}
	},

	unsubscribe(action) {
		this.actions.delete(action);
		if (this.actions.size === 0) {
			clearInterval(this.timer);
			this.timer = null;
		}
	},

	async poll() {
		let keys = 0;
		for (const action of this.actions) keys += action.keys.size;
		this.reading = await call("GET", "/v1/reading", keys);
		for (const action of this.actions) action.show(action.render(this.reading));
	},
};

// ---------- actions ----------

class MeterAction extends SingletonAction {
	keys = new Map();
	image = null;

	onWillAppear(ev) {
		this.keys.set(ev.action.id, ev.action);
		ev.action.setTitle("");
		if (this.keys.size === 1) poller.subscribe(this);
		return ev.action.setImage(this.image ?? this.render(poller.reading));
	}

	onWillDisappear(ev) {
		this.keys.delete(ev.action.id);
		if (this.keys.size === 0) poller.unsubscribe(this);
	}

	/** While the app is closed, every key's press starts it. */
	async onKeyDown(ev) {
		if (!poller.reading) {
			if (await launchApp()) {
				await ev.action.showOk();
				setTimeout(() => poller.poll(), 4_000);
			} else {
				await ev.action.showAlert();
			}
			return;
		}
		await this.press(ev);
	}

	offline(label) {
		return renderGauge({ label, fill: null, number: "--", detail: "OFF" });
	}

	async show(image) {
		this.image = image;
		await Promise.all([...this.keys.values()].map((action) => action.setImage(image).catch((err) => streamDeck.logger.warn(err.message))));
	}
}

class TankAction extends MeterAction {
	/** @abstract window key in the reading, and the label drawn on the key */
	window = "";
	label = "";

	render(reading) {
		if (!reading) return this.offline(this.label);
		const tank = reading[this.window];
		if (tank?.percentLeft == null) {
			// Codex has no 5-hour window at all; Claude before its first reading just has none yet.
			const detail = tank?.source === "unsupported" ? "N/A" : "…";
			return renderGauge({ label: this.label, fill: null, number: "--", detail });
		}
		const left = tank.percentLeft;
		return renderGauge({
			label: this.label,
			fill: left / 100,
			color: tankColor(left),
			number: String(Math.round(left)),
			unit: "%",
			detail: formatCountdown(tank.resetsAt) || (tank.tokensLeft != null ? `~${formatTokens(tank.tokensLeft)}` : ""),
		});
	}

	// Asks the app for the same "Refresh now" the tray offers; it still respects the endpoint's floor.
	async press(ev) {
		const ok = await call("POST", "/v1/refresh");
		await (ok ? ev.action.showOk() : ev.action.showAlert());
		setTimeout(() => poller.poll(), 3_000);
	}
}

class WeekAction extends TankAction {
	manifestId = "com.williamfan.llmmeter.week";
	window = "sevenDay";
	label = "WEEK";
}

class FiveHourAction extends TankAction {
	manifestId = "com.williamfan.llmmeter.fivehour";
	window = "fiveHour";
	label = "5H";
}

class RateAction extends MeterAction {
	manifestId = "com.williamfan.llmmeter.rate";

	render(reading) {
		if (!reading) return this.offline("TOK/MIN");
		const rate = reading.tokensPerMinute || 0;
		return renderGauge({
			label: "TOK/MIN",
			fill: rate / RATE_MAX,
			color: rateColor(rate),
			number: formatTokens(rate),
			detail: reading.costWeek != null ? `$${reading.costWeek.toFixed(0)} wk` : "",
		});
	}

	async press(ev) {
		const ok = await call("POST", "/v1/show");
		if (!ok) await ev.action.showAlert();
	}
}

streamDeck.logger.setLevel("info");
streamDeck.actions.registerAction(new WeekAction());
streamDeck.actions.registerAction(new FiveHourAction());
streamDeck.actions.registerAction(new RateAction());
streamDeck.connect();
