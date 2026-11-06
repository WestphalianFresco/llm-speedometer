import assert from "node:assert/strict";
import { test } from "node:test";
import { fromSessionFile, READING_STALE_MS } from "../src/reading.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const tank = (percentLeft, resetsAt) => ({ percentLeft, resetsAt, source: "official", tokensLeft: null, tokensUsed: null });
const file = (extra = {}) =>
	JSON.stringify({ v: 1, at: NOW, source: "claude-code", tokensPerMinute: 96, fiveHour: tank(60, NOW + HOUR), sevenDay: tank(91, NOW + 10 * HOUR), tripTokens: 2150, ...extra });

test("a fresh file maps to the app's reading shape", () => {
	const r = fromSessionFile(file(), NOW);
	assert.deepEqual(r, {
		v: 1, at: NOW, source: "claude-code", tokensPerMinute: 96,
		fiveHour: tank(60, NOW + HOUR), sevenDay: tank(91, NOW + 10 * HOUR),
		costWeek: null, lifetimeTokens: null, tripTokens: 2150,
	});
});

test("a stale file keeps the quota and drops the rate", () => {
	const r = fromSessionFile(file(), NOW + READING_STALE_MS + 1);
	assert.equal(r.tokensPerMinute, 0);
	assert.equal(r.fiveHour.percentLeft, 60);
});

test("a window whose reset has passed shows as no reading", () => {
	const r = fromSessionFile(file(), NOW + HOUR);
	assert.equal(r.fiveHour.percentLeft, null);
	assert.equal(r.fiveHour.resetsAt, null);
	assert.equal(r.sevenDay.percentLeft, 91);
});

test("junk in, nothing invented out", () => {
	assert.equal(fromSessionFile("not json", NOW), null);
	assert.equal(fromSessionFile("null", NOW), null);
	assert.equal(fromSessionFile(JSON.stringify({ v: 2, at: NOW, source: "claude-code" }), NOW), null);
	assert.equal(fromSessionFile(JSON.stringify({ v: 1, at: NOW, source: "someone-else" }), NOW), null);
	assert.equal(fromSessionFile(file({ at: "yesterday" }), NOW), null);
	const r = fromSessionFile(file({ tokensPerMinute: -4, tripTokens: "lots", fiveHour: { percentLeft: 130 }, sevenDay: 7 }), NOW);
	assert.equal(r.tokensPerMinute, 0);
	assert.equal(r.tripTokens, null);
	assert.equal(r.fiveHour.percentLeft, 100);
	assert.equal(r.fiveHour.resetsAt, null);
	assert.equal(r.sevenDay.percentLeft, null);
});
