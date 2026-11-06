import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// What a Claude Code session running the LLM Speedometer plugin leaves behind:
// the shape of the app's GET /v1/reading, so the keys draw it the same way
// while the app is closed. Nothing here is trusted to be the shape it claims.
export const READING_FILE = join(homedir(), ".llm-speedometer", "reading.json");
// A session that stopped writing is not producing, whatever rate it last saw.
export const READING_STALE_MS = 90_000;

const EMPTY_TANK = { percentLeft: null, resetsAt: null, source: null, tokensLeft: null, tokensUsed: null };
const finite = (n) => typeof n === "number" && Number.isFinite(n);

export function fromSessionFile(text, now = Date.now()) {
	let r;
	try {
		r = JSON.parse(text);
	} catch {
		return null;
	}
	if (!r || r.v !== 1 || r.source !== "claude-code" || !finite(r.at)) return null;
	const tank = (t) => {
		// A reading from before its window reset says nothing about the new one.
		if (!t || !finite(t.percentLeft) || (finite(t.resetsAt) && t.resetsAt <= now)) return { ...EMPTY_TANK };
		return {
			percentLeft: Math.max(0, Math.min(100, t.percentLeft)),
			resetsAt: finite(t.resetsAt) ? t.resetsAt : null,
			source: "official",
			tokensLeft: null,
			tokensUsed: null,
		};
	};
	const stale = now - r.at > READING_STALE_MS;
	return {
		v: 1,
		at: r.at,
		source: "claude-code",
		tokensPerMinute: !stale && finite(r.tokensPerMinute) && r.tokensPerMinute > 0 ? r.tokensPerMinute : 0,
		fiveHour: tank(r.fiveHour),
		sevenDay: tank(r.sevenDay),
		costWeek: null,
		lifetimeTokens: null,
		tripTokens: finite(r.tripTokens) && r.tripTokens >= 0 ? r.tripTokens : null,
	};
}

export async function readSessionFile() {
	try {
		return fromSessionFile(await readFile(READING_FILE, "utf8"));
	} catch {
		return null; // no session has run with the plugin yet
	}
}
