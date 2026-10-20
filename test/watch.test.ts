import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import type { ProcessTable, ProcRow } from "../src/core/group.ts";
import { DEATH_WINDOW_MS, STALLED_AFTER_MS } from "../src/core/lineage.ts";
import { claim, deliver, ensureMailbox, messagesSince, pending } from "../src/core/maildir.ts";
import type { Call, Message } from "../src/core/message.ts";
import { type PidProbe, type Presence, STALE_AFTER_MS, writePresence } from "../src/core/registry.ts";
import { type ChildWatch, childrenAfter, filesToRead, lookAfterChildren, newWatch, type Scope } from "../src/core/watch.ts";
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
	/** A look whose process listing finds nothing, so these tests never spawn ps. */
	const lookAt = (watch: ChildWatch, scope: Scope, at: number, awakeSince: number, probe: PidProbe = alive, stalledAfterMs = STALLED_AFTER_MS, table: ProcessTable = () => []) =>
		lookAfterChildren(root, BOSS, watch, scope, at, awakeSince, probe, stalledAfterMs, table);

	test("a child stuck in one call past the threshold gets one stalled, from it, naming its life and call, with the stop command", () => {
		writePresence(root, busy(stuck, now, { pid: 4242 }));
		const look = lookAt(newWatch(), "full", now, 0, alive);
		expect(look.posted.map((notice) => [notice.from.id, notice.to, notice.kind, notice.life, notice.call])).toEqual([
			["k-1", BOSS, "stalled", { pid: 4242, startedAt: now - 3_600_000 }, stuck],
		]);
		expect(look.posted[0]?.text).toContain("bash: sleep 613\n");
		expect(look.posted[0]?.text).toContain("run `kill 4242`");
		expect(ids(look.watch.watched)).toEqual(["k-1"]);
		writePresence(root, busy(stuck, now + 10_000, { pid: 4242 }));
		expect(lookAt(look.watch, "full", now + 10_000, 0, alive).posted).toEqual([]);
		expect(stalledIn(BOSS).length).toBe(1);
	});

	test("a quick look doesn't judge a record it didn't reread; the next full look does", () => {
		writePresence(root, busy(sleeping("c1", now - 5_000)));
		const start = lookAt(newWatch(), "full", now, 0, alive, 8_000);
		const quick = lookAt(start.watch, "quick", now + 4_000, 0, alive, 8_000);
		expect([start.posted, quick.records, quick.posted]).toEqual([[], [], []]);
		const full = lookAt(quick.watch, "full", now + 6_000, 0, alive, 8_000);
		expect(calls(full)).toEqual(["c1"]);
	});

	test("a call that ended between looks isn't judged from the record as last read", () => {
		writePresence(root, busy(sleeping("c1", now - 5_000)));
		const start = lookAt(newWatch(), "full", now, 0, alive, 8_000);
		writePresence(root, busy(undefined, now + 3_000));
		const quick = lookAt(start.watch, "quick", now + 4_000, 0, alive, 8_000);
		const full = lookAt(quick.watch, "full", now + 10_000, 0, alive, 8_000);
		expect([quick.posted, full.posted]).toEqual([[], []]);
		expect(stalledIn(BOSS)).toEqual([]);
	});

	test("once per call, even across restarts: its notice in the inbox, new/ or cur/, is the evidence", () => {
		writePresence(root, busy(stuck));
		expect(calls(lookAt(newWatch(), "full", now, 0, alive))).toEqual(["c1"]);
		const restarted = now + 60_000;
		const judged = restarted + STALLED_AFTER_MS + 1;
		writePresence(root, busy(stuck, judged));
		expect(lookAt(newWatch(), "full", judged, restarted, alive).posted).toEqual([]);
		for (const file of pending(root, BOSS)) claim(root, BOSS, file);
		expect(lookAt(newWatch(), "full", judged + 1, restarted, alive).posted).toEqual([]);
		expect(stalledIn(BOSS).length).toBe(1);
	});

	test("a parent that just started gives a long-stuck call the threshold again before reporting it", () => {
		writePresence(root, busy(sleeping("c1", now - 3_600_000)));
		expect(lookAt(newWatch(), "full", now, now, alive).posted).toEqual([]);
		writePresence(root, busy(sleeping("c1", now - 3_600_000), now + STALLED_AFTER_MS + 1));
		expect(calls(lookAt(newWatch(), "full", now + STALLED_AFTER_MS + 1, now, alive))).toEqual(["c1"]);
	});

	test("a later stall, on another call, is reported again", () => {
		writePresence(root, busy(stuck));
		const first = lookAt(newWatch(), "full", now, 0, alive);
		const later = now + 60_000;
		const judged = later + STALLED_AFTER_MS + 1;
		writePresence(root, busy(sleeping("c2", later), judged));
		const second = lookAt(first.watch, "full", judged, 0, alive);
		expect([calls(first), calls(second)]).toEqual([["c1"], ["c2"]]);
		expect(lookAt(newWatch(), "full", judged + 1, 0, alive).posted).toEqual([]);
		expect(stalledIn(BOSS).map((notice) => notice.call?.id).sort()).toEqual(["c1", "c2"]);
	});

	test("a stuck child whose process is gone died: one died, no stalled", () => {
		writePresence(root, busy(stuck, now, { pid: 7 }));
		const look = lookAt(newWatch(), "full", now, 0, pids(7));
		expect(look.posted.map((notice) => notice.kind)).toEqual(["died"]);
	});

	test("a death and a stall in one look: both reported, both remembered", () => {
		writePresence(root, busy(stuck));
		writePresence(root, kid("k-2", { pid: 7 }));
		const look = lookAt(newWatch(), "full", now, 0, pids(7));
		expect(look.posted.map((notice) => [notice.from.id, notice.kind])).toEqual([
			["k-2", "died"],
			["k-1", "stalled"],
		]);
		expect(look.watch.notices.map((notice) => notice.kind)).toEqual(["died", "stalled"]);
		writePresence(root, busy(stuck, now + 10_000));
		expect(lookAt(look.watch, "full", now + 10_000, 0, pids(7)).posted).toEqual([]);
	});

	test("other sessions' stuck subs and idle children are nobody's stall here", () => {
		writePresence(root, presence({ id: "nephew", parent: "other", pid: 10, heartbeatAt: now - 1_000, call: stuck }));
		writePresence(root, kid("k-3", { heartbeatAt: now - 1_000 }));
		expect(lookAt(newWatch(), "full", now, 0, alive).posted).toEqual([]);
	});

	test("a stall notice that can't be posted isn't evidence: the next full look tries again", () => {
		writePresence(root, busy(stuck));
		const { tmp } = ensureMailbox(root, BOSS);
		chmodSync(tmp, 0o500);
		const failed = lookAt(newWatch(), "full", now, 0, alive);
		chmodSync(tmp, 0o700);
		expect(failed.failed.map((failure) => [failure.child.id, failure.kind])).toEqual([["k-1", "stalled"]]);
		expect(failed.posted).toEqual([]);
		expect(calls(lookAt(failed.watch, "full", now + 10_000, 0, alive))).toEqual(["c1"]);
		expect(stalledIn(BOSS).length).toBe(1);
	});
});

describe("a stalled bash call's notice names the command's own process group", () => {
	const SUB_PID = 4242;
	const stuck: Call = { id: "c1", name: "bash", preview: "sleep 613", since: now - STALLED_AFTER_MS - 1 };
	const busy = (id: string, pid: number, call: Call): Presence => kid(id, { pid, activity: "busy", startedAt: now - 3_600_000, heartbeatAt: now - 1_000, call });
	/** How ps lists the shell pi started for `call`: a direct child of the sub's pi that leads its own group. */
	const shellOf = (call: Call, pid: number, subPid = SUB_PID): ProcRow => ({ pid, ppid: subPid, pgid: pid, elapsedMs: Math.floor((now - call.since) / 1_000) * 1_000 });
	const piItself: ProcRow = { pid: SUB_PID, ppid: 900, pgid: 900, elapsedMs: 3_600_000 };
	/** A process listing that counts how often it ran. */
	const listing = (rows: readonly ProcRow[] | undefined) => {
		let runs = 0;
		const table: ProcessTable = () => {
			runs += 1;
			return rows;
		};
		return { table, runs: () => runs };
	};
	const lookWith = (table: ProcessTable, watch = newWatch(), at = now) => lookAfterChildren(root, BOSS, watch, "full", at, 0, alive, STALLED_AFTER_MS, table);
	const lines = (look: { readonly posted: readonly Message[] }) => look.posted[0]?.text.split("\n") ?? [];

	test("ps once; stopping just the command comes first, then the whole sub, then leaving it", () => {
		writePresence(root, busy("k-1", SUB_PID, stuck));
		const ps = listing([piItself, shellOf(stuck, 5001), { pid: 5002, ppid: 5001, pgid: 5001, elapsedMs: 60_000 }]);
		const look = lookWith(ps.table);
		expect(ps.runs()).toBe(1);
		expect(lines(look).slice(3)).toEqual([
			"To stop just that command, run `kill -- -5001` (its process group): the call comes back failed and k-1 carries on, context intact. To tell it what to do instead, msg_send it first: a busy sub reads your message as soon as its running calls return, before its next step.",
			"To stop k-1 itself, run `kill 4242`: pi kills the commands it's running (each one's whole process group) and ends, and k-1 reports ended, stopped, with its last words.",
			"Or leave it, if that's a legit long command: you won't hear about this call again.",
		]);
		expect(look.posted[0]?.call).toEqual(stuck);
		expect(Object.keys(look.posted[0] ?? {}).sort()).toEqual(["call", "from", "id", "kind", "life", "text", "to", "ts", "v"]);
	});

	test("ps failing, or not exactly one group: no group line, and the notice reads as before", () => {
		const today = "To stop it, run `kill 4242`: pi kills the commands it's running (each one's whole process group) and ends, and k-1 reports ended, stopped, with its last words.";
		const twins = [shellOf(stuck, 5001), shellOf({ ...stuck, since: stuck.since + 500 }, 5003)];
		const elsewhere = [shellOf(stuck, 5001, 4243), { ...shellOf(stuck, 5004), pgid: 900 }];
		const cases = [undefined, [], [piItself], twins, elsewhere];
		for (const [index, rows] of cases.entries()) {
			writePresence(root, busy("k-1", SUB_PID, { ...stuck, id: `c-${index}` }));
			const text = lookWith(listing(rows).table).posted[0]?.text ?? "";
			expect([index, text.split("\n").slice(3)]).toEqual([index, [today, "Or leave it, if that's a legit long command: you won't hear about this call again."]]);
			expect(text).not.toContain("kill -- -");
		}
	});

	test("ps never runs on a look without a stall to report, nor for a call that isn't bash", () => {
		const ps = listing([piItself, shellOf(stuck, 5001)]);
		writePresence(root, kid("k-1", { pid: SUB_PID, heartbeatAt: now - 1_000 }));
		expect(lookWith(ps.table).posted).toEqual([]);
		writePresence(root, busy("k-1", SUB_PID, { ...stuck, id: "c0", since: now - 60_000 }));
		expect(lookWith(ps.table).posted).toEqual([]);
		writePresence(root, busy("k-1", SUB_PID, { id: "c2", name: "wait_for_ci", since: stuck.since }));
		const other = lookWith(ps.table);
		expect(other.posted.map((notice) => notice.call?.name)).toEqual(["wait_for_ci"]);
		expect(other.posted[0]?.text).toContain("To stop it, run `kill 4242`");
		expect(ps.runs()).toBe(0);
	});

	test("ps never runs again for a stall already reported, in this run or an earlier one", () => {
		writePresence(root, busy("k-1", SUB_PID, stuck));
		const ps = listing([piItself, shellOf(stuck, 5001)]);
		const first = lookWith(ps.table);
		expect(first.posted.length).toBe(1);
		writePresence(root, busy("k-1", SUB_PID, stuck));
		expect(lookWith(ps.table, first.watch, now + 10_000).posted).toEqual([]);
		expect(lookWith(ps.table, newWatch(), now + 20_000).posted).toEqual([]);
		expect(ps.runs()).toBe(1);
	});

	test("two subs stalled in one look: ps once, each notice its own group", () => {
		writePresence(root, busy("k-1", SUB_PID, stuck));
		writePresence(root, busy("k-2", 4343, { ...stuck, id: "c9" }));
		const ps = listing([piItself, shellOf(stuck, 5001), shellOf(stuck, 6001, 4343)]);
		const look = lookWith(ps.table);
		expect(ps.runs()).toBe(1);
		expect(look.posted.map((notice) => [notice.from.id, /`kill -- -(\d+)`/.exec(notice.text)?.[1]]).sort()).toEqual([
			["k-1", "5001"],
			["k-2", "6001"],
		]);
	});
});
