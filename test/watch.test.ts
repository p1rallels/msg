import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { DEATH_WINDOW_MS, STALLED_AFTER_MS } from "../src/core/lineage.ts";
import { claim, deliver, ensureMailbox, messagesSince, pending } from "../src/core/maildir.ts";
import type { Call, Message } from "../src/core/message.ts";
import { type Presence, STALE_AFTER_MS, writePresence } from "../src/core/registry.ts";
import { type ChildWatch, childrenAfter, filesToRead, lookAfterChildren, newWatch } from "../src/core/watch.ts";
import { message, presence, tempRoot } from "./helpers.ts";

let root = "";
let cleanup = () => {};

beforeEach(() => {
	({ root, cleanup } = tempRoot());
});

afterEach(() => cleanup());

const BOSS = "boss-1";
const now = 1_700_000_000_000;
const alive = () => true;
const pids = (...dead: number[]) => (pid: number) => !dead.includes(pid);
const kid = (id: string, overrides: Partial<Presence> = {}): Presence =>
	presence({ id, parent: BOSS, pid: 100, startedAt: now - 60_000, heartbeatAt: now - 1_000, ...overrides });
const diedIn = (box: string): Message[] => messagesSince(root, box, 0).filter((message) => message.kind === "died");
const ids = (records: readonly Presence[]) => records.map((record) => record.id);

describe("quick looks", () => {
	test("filesToRead: new files and outdated watched children (pid gone, stale heartbeat), nothing else", () => {
		const watch: ChildWatch = {
			files: new Set(["a.json", "b.json", "c.json", "me.json"]),
			watched: [kid("a", { pid: 7 }), kid("b", { heartbeatAt: now - STALE_AFTER_MS - 1 }), kid("c")],
			notices: [],
		};
		const wanted = filesToRead(watch, now, pids(7));
		expect(["a.json", "b.json", "c.json", "me.json", "new.json"].filter(wanted)).toEqual(["a.json", "b.json", "new.json"]);
	});

	test("childrenAfter: children among the records read, plus watched ones not read whose file is still there", () => {
		const look = { files: new Set(["a.json", "b.json", "c.json", "x.json", "y.json"]), records: [kid("b", { heartbeatAt: now }), kid("c", { parent: "other" }), kid("x"), presence({ id: "y" })] };
		const after = childrenAfter([kid("a"), kid("b"), kid("c"), kid("gone")], look, BOSS);
		expect(after.map((record) => [record.id, record.heartbeatAt])).toEqual([
			["a", now - 1_000],
			["b", now],
			["x", now - 1_000],
		]);
	});

	test("one that finds nothing new reads no record; a watched child's death shows in its pid", () => {
		writePresence(root, kid("k-1", { pid: 7 }));
		writePresence(root, presence({ id: "stranger", heartbeatAt: now }));
		const start = lookAfterChildren(root, BOSS, newWatch(), "full", now, now, alive);
		expect(ids(start.records).sort()).toEqual(["k-1", "stranger"]);
		expect(ids(start.watch.watched)).toEqual(["k-1"]);
		const calm = lookAfterChildren(root, BOSS, start.watch, "quick", now + 2_000, now, alive);
		expect(calm.records).toEqual([]);
		expect(ids(calm.watch.watched)).toEqual(["k-1"]);
		const killed = lookAfterChildren(root, BOSS, calm.watch, "quick", now + 4_000, now, pids(7));
		expect(ids(killed.records)).toEqual(["k-1"]);
		expect(killed.posted.map((notice) => [notice.from.id, notice.kind, notice.text.includes("(pid 7) is gone")])).toEqual([["k-1", "died", true]]);
		expect(killed.watch.watched).toEqual([]);
	});

	test("a child that started and died between two looks gets its died, though never seen live", () => {
		const start = lookAfterChildren(root, BOSS, newWatch(), "full", now, now, alive);
		const flash = kid("k-1", { pid: 7, startedAt: now + 500, heartbeatAt: now + 500 });
		writePresence(root, flash);
		const next = lookAfterChildren(root, BOSS, start.watch, "quick", now + 2_000, now, pids(7));
		expect(next.posted.map((notice) => [notice.from.id, notice.life])).toEqual([["k-1", { pid: 7, startedAt: now + 500 }]]);
		const after = lookAfterChildren(root, BOSS, next.watch, "quick", now + 4_000, now, pids(7));
		const full = lookAfterChildren(root, BOSS, after.watch, "full", now + 10_000, now, pids(7));
		expect([after.posted, full.posted]).toEqual([[], []]);
		expect(diedIn(BOSS).length).toBe(1);
	});

	test("a session resumed from our bash rewrites a known file: the next full look finds it", () => {
		writePresence(root, presence({ id: "k-1", pid: 7, heartbeatAt: now - 86_400_000, endedAt: now - 86_400_000 }));
		const start = lookAfterChildren(root, BOSS, newWatch(), "full", now, now, pids(7));
		writePresence(root, kid("k-1", { pid: 8, startedAt: now + 500, heartbeatAt: now + 500 }));
		const quick = lookAfterChildren(root, BOSS, start.watch, "quick", now + 2_000, now, pids(7, 8));
		expect(quick.posted).toEqual([]);
		const full = lookAfterChildren(root, BOSS, quick.watch, "full", now + 10_000, now, pids(7, 8));
		expect(full.posted.map((notice) => notice.life?.pid)).toEqual([8]);
	});

	test("budget: 500 records, a quick look that finds nothing new reads none and stays well under 2ms", () => {
		for (let index = 0; index < 500; index++) {
			writePresence(root, presence({ id: `s-${index}`, pid: process.pid, heartbeatAt: now, ...(index % 50 === 0 ? { parent: BOSS } : {}) }));
		}
		let watch = lookAfterChildren(root, BOSS, newWatch(), "full", now, now).watch;
		expect(watch.watched.length).toBe(10);
		const times: number[] = [];
		for (let round = 0; round < 50; round++) {
			const started = performance.now();
			const look = lookAfterChildren(root, BOSS, watch, "quick", now + 2_000, now);
			times.push(performance.now() - started);
			expect(look.records).toEqual([]);
			watch = look.watch;
		}
		const median = [...times].sort((a, b) => a - b)[times.length / 2] ?? Number.POSITIVE_INFINITY;
		expect(median).toBeLessThan(2);
	});
});

describe("deaths are reported once, with the inbox as the evidence", () => {
	test("a child that died while its parent was away is reported at the next start, once however often it restarts", () => {
		const dead = kid("k-1", { pid: 7, heartbeatAt: now - 3_600_000 });
		writePresence(root, dead);
		writePresence(root, presence({ id: BOSS, heartbeatAt: now }));
		const first = lookAfterChildren(root, BOSS, newWatch(), "full", now, now, pids(7));
		expect(first.posted.map((notice) => [notice.from.id, notice.to, notice.life])).toEqual([["k-1", BOSS, { pid: 7, startedAt: dead.startedAt }]]);
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", now + 60_000, now + 60_000, pids(7)).posted).toEqual([]);
		for (const file of pending(root, BOSS)) claim(root, BOSS, file);
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", now + 120_000, now + 120_000, pids(7)).posted).toEqual([]);
		expect(diedIn(BOSS).length).toBe(1);
	});

	test("a death reported live isn't repeated after a restart", () => {
		writePresence(root, kid("k-1", { pid: 7 }));
		const start = lookAfterChildren(root, BOSS, newWatch(), "full", now, now, alive);
		expect(lookAfterChildren(root, BOSS, start.watch, "quick", now + 2_000, now, pids(7)).posted.length).toBe(1);
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", now + 600_000, now + 600_000, pids(7)).posted).toEqual([]);
		expect(diedIn(BOSS).length).toBe(1);
	});

	test("a child resumed and killed again is a new death", () => {
		writePresence(root, kid("k-1", { pid: 7, startedAt: now - 60_000, heartbeatAt: now - 50_000 }));
		const first = lookAfterChildren(root, BOSS, newWatch(), "full", now, now, pids(7, 8));
		writePresence(root, kid("k-1", { pid: 8, startedAt: now + 1_000, heartbeatAt: now + 1_000 }));
		const second = lookAfterChildren(root, BOSS, first.watch, "full", now + 10_000, now, pids(7, 8));
		expect([first.posted.map((notice) => notice.life?.pid), second.posted.map((notice) => notice.life?.pid)]).toEqual([[7], [8]]);
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", now + 20_000, now + 20_000, pids(7, 8)).posted).toEqual([]);
	});

	test("a notice from an older msg, without a life, counts when it came after the last heartbeat", () => {
		writePresence(root, kid("k-1", { pid: 7, heartbeatAt: now - 60_000 }));
		deliver(root, message({ to: BOSS, from: { id: "k-1" }, kind: "died", text: "gone" }, now - 30_000));
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", now, now, pids(7)).posted).toEqual([]);
	});

	test("ended, live, long-dead children and other sessions' children get nothing", () => {
		writePresence(root, kid("ended", { pid: 7, endedAt: now - 1_000 }));
		writePresence(root, kid("live", { pid: 8, heartbeatAt: now }));
		writePresence(root, kid("ancient", { pid: 9, heartbeatAt: now - DEATH_WINDOW_MS - 1 }));
		writePresence(root, presence({ id: "nephew", parent: "other", pid: 10, heartbeatAt: now - 1_000 }));
		const look = lookAfterChildren(root, BOSS, newWatch(), "full", now, now, pids(7, 9, 10));
		expect(look.posted).toEqual([]);
		expect(ids(look.watch.watched)).toEqual(["live"]);
		expect(diedIn(BOSS)).toEqual([]);
	});

	test("a child that marks itself ended and exits between the read and the probe ended, it didn't die", () => {
		const record = kid("k-1", { pid: 7 });
		writePresence(root, record);
		const endsMeanwhile = (pid: number) => {
			writePresence(root, { ...record, endedAt: now });
			return pid !== 7;
		};
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", now, now, endsMeanwhile).posted).toEqual([]);
		expect(diedIn(BOSS)).toEqual([]);
	});

	test("a notice that can't be posted isn't evidence: the next full look tries again", () => {
		writePresence(root, kid("k-1", { pid: 7 }));
		const { tmp } = ensureMailbox(root, BOSS);
		chmodSync(tmp, 0o500);
		const failed = lookAfterChildren(root, BOSS, newWatch(), "full", now, now, pids(7));
		chmodSync(tmp, 0o700);
		expect(failed.failed.map((failure) => [failure.child.id, failure.kind])).toEqual([["k-1", "died"]]);
		expect(failed.posted).toEqual([]);
		expect(lookAfterChildren(root, BOSS, failed.watch, "full", now + 10_000, now, pids(7)).posted.length).toBe(1);
		expect(diedIn(BOSS).length).toBe(1);
	});
});

describe("stalls are reported once per call, with the inbox as the evidence", () => {
	const stalledIn = (box: string): Message[] => messagesSince(root, box, 0).filter((message) => message.kind === "stalled");
	const sleeping = (id: string, since: number): Call => ({ id, name: "bash", preview: "sleep 613", since });
	/** A child whose record, written at `at`, shows `call` running. */
	const busy = (call: Call | undefined, at = now, overrides: Partial<Presence> = {}): Presence =>
		kid("k-1", { activity: "busy", startedAt: now - 3_600_000, heartbeatAt: at - 1_000, ...(call ? { call } : {}), ...overrides });
	const stuck = sleeping("c1", now - STALLED_AFTER_MS - 1);
	const calls = (look: { readonly posted: readonly Message[] }) => look.posted.map((notice) => notice.call?.id);

	test("a child stuck in one call past the threshold gets one stalled, from it, naming its life and call, with the stop command", () => {
		writePresence(root, busy(stuck, now, { pid: 4242 }));
		const look = lookAfterChildren(root, BOSS, newWatch(), "full", now, 0, alive);
		expect(look.posted.map((notice) => [notice.from.id, notice.to, notice.kind, notice.life, notice.call])).toEqual([
			["k-1", BOSS, "stalled", { pid: 4242, startedAt: now - 3_600_000 }, stuck],
		]);
		expect(look.posted[0]?.text).toContain("bash: sleep 613\n");
		expect(look.posted[0]?.text).toContain("run `kill 4242`");
		expect(ids(look.watch.watched)).toEqual(["k-1"]);
		writePresence(root, busy(stuck, now + 10_000, { pid: 4242 }));
		expect(lookAfterChildren(root, BOSS, look.watch, "full", now + 10_000, 0, alive).posted).toEqual([]);
		expect(stalledIn(BOSS).length).toBe(1);
	});

	test("a quick look doesn't judge a record it didn't reread; the next full look does", () => {
		writePresence(root, busy(sleeping("c1", now - 5_000)));
		const start = lookAfterChildren(root, BOSS, newWatch(), "full", now, 0, alive, 8_000);
		const quick = lookAfterChildren(root, BOSS, start.watch, "quick", now + 4_000, 0, alive, 8_000);
		expect([start.posted, quick.records, quick.posted]).toEqual([[], [], []]);
		const full = lookAfterChildren(root, BOSS, quick.watch, "full", now + 6_000, 0, alive, 8_000);
		expect(calls(full)).toEqual(["c1"]);
	});

	test("a call that ended between looks isn't judged from the record as last read", () => {
		writePresence(root, busy(sleeping("c1", now - 5_000)));
		const start = lookAfterChildren(root, BOSS, newWatch(), "full", now, 0, alive, 8_000);
		writePresence(root, busy(undefined, now + 3_000));
		const quick = lookAfterChildren(root, BOSS, start.watch, "quick", now + 4_000, 0, alive, 8_000);
		const full = lookAfterChildren(root, BOSS, quick.watch, "full", now + 10_000, 0, alive, 8_000);
		expect([quick.posted, full.posted]).toEqual([[], []]);
		expect(stalledIn(BOSS)).toEqual([]);
	});

	test("once per call, even across restarts: its notice in the inbox, new/ or cur/, is the evidence", () => {
		writePresence(root, busy(stuck));
		expect(calls(lookAfterChildren(root, BOSS, newWatch(), "full", now, 0, alive))).toEqual(["c1"]);
		const restarted = now + 60_000;
		const judged = restarted + STALLED_AFTER_MS + 1;
		writePresence(root, busy(stuck, judged));
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", judged, restarted, alive).posted).toEqual([]);
		for (const file of pending(root, BOSS)) claim(root, BOSS, file);
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", judged + 1, restarted, alive).posted).toEqual([]);
		expect(stalledIn(BOSS).length).toBe(1);
	});

	test("a parent that just started gives a long-stuck call the threshold again before reporting it", () => {
		writePresence(root, busy(sleeping("c1", now - 3_600_000)));
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", now, now, alive).posted).toEqual([]);
		writePresence(root, busy(sleeping("c1", now - 3_600_000), now + STALLED_AFTER_MS + 1));
		expect(calls(lookAfterChildren(root, BOSS, newWatch(), "full", now + STALLED_AFTER_MS + 1, now, alive))).toEqual(["c1"]);
	});

	test("a later stall, on another call, is reported again", () => {
		writePresence(root, busy(stuck));
		const first = lookAfterChildren(root, BOSS, newWatch(), "full", now, 0, alive);
		const later = now + 60_000;
		const judged = later + STALLED_AFTER_MS + 1;
		writePresence(root, busy(sleeping("c2", later), judged));
		const second = lookAfterChildren(root, BOSS, first.watch, "full", judged, 0, alive);
		expect([calls(first), calls(second)]).toEqual([["c1"], ["c2"]]);
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", judged + 1, 0, alive).posted).toEqual([]);
		expect(stalledIn(BOSS).map((notice) => notice.call?.id).sort()).toEqual(["c1", "c2"]);
	});

	test("a stuck child whose process is gone died: one died, no stalled", () => {
		writePresence(root, busy(stuck, now, { pid: 7 }));
		const look = lookAfterChildren(root, BOSS, newWatch(), "full", now, 0, pids(7));
		expect(look.posted.map((notice) => notice.kind)).toEqual(["died"]);
	});

	test("a death and a stall in one look: both reported, both remembered", () => {
		writePresence(root, busy(stuck));
		writePresence(root, kid("k-2", { pid: 7 }));
		const look = lookAfterChildren(root, BOSS, newWatch(), "full", now, 0, pids(7));
		expect(look.posted.map((notice) => [notice.from.id, notice.kind])).toEqual([
			["k-2", "died"],
			["k-1", "stalled"],
		]);
		expect(look.watch.notices.map((notice) => notice.kind)).toEqual(["died", "stalled"]);
		writePresence(root, busy(stuck, now + 10_000));
		expect(lookAfterChildren(root, BOSS, look.watch, "full", now + 10_000, 0, pids(7)).posted).toEqual([]);
	});

	test("other sessions' stuck subs and idle children are nobody's stall here", () => {
		writePresence(root, presence({ id: "nephew", parent: "other", pid: 10, heartbeatAt: now - 1_000, call: stuck }));
		writePresence(root, kid("k-3", { heartbeatAt: now - 1_000 }));
		expect(lookAfterChildren(root, BOSS, newWatch(), "full", now, 0, alive).posted).toEqual([]);
	});

	test("a stall notice that can't be posted isn't evidence: the next full look tries again", () => {
		writePresence(root, busy(stuck));
		const { tmp } = ensureMailbox(root, BOSS);
		chmodSync(tmp, 0o500);
		const failed = lookAfterChildren(root, BOSS, newWatch(), "full", now, 0, alive);
		chmodSync(tmp, 0o700);
		expect(failed.failed.map((failure) => [failure.child.id, failure.kind])).toEqual([["k-1", "stalled"]]);
		expect(failed.posted).toEqual([]);
		expect(calls(lookAfterChildren(root, BOSS, failed.watch, "full", now + 10_000, 0, alive))).toEqual(["c1"]);
		expect(stalledIn(BOSS).length).toBe(1);
	});
});
