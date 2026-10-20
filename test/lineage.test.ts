import { describe, expect, test } from "bun:test";
import { DELIVERED_TTL_MS } from "../src/core/housekeeping.ts";
import {
	type CallStart,
	callEnded,
	callStarted,
	canStall,
	DEATH_WINDOW_MS,
	diedText,
	endedText,
	familyOf,
	hasFamily,
	inheritedParent,
	isNoticeOf,
	isStallNoticeOf,
	lifeOf,
	nestedRefusal,
	noteWords,
	oldestCall,
	previewOf,
	relationOf,
	reportWords,
	type RunState,
	type Stall,
	STALLED_AFTER_MS,
	stalledAfter,
	stalledText,
	stallsOf,
	startAs,
	stopCommand,
	wasStopped,
	watchChildren,
	wordsIn,
} from "../src/core/lineage.ts";
import { type Call, createMessage, type Life, MAX_PREVIEW_LENGTH, MAX_TEXT_BYTES, textBytes } from "../src/core/message.ts";
import { type Presence, STALE_AFTER_MS } from "../src/core/registry.ts";
import { message, presence } from "./helpers.ts";

const PARENT = "01a152a0-f00d-72aa-a896-d904c458282b";
const SELF = "01a152d4-d2c3-751d-ab2f-1d14f1974871";

describe("inheritedParent", () => {
	test("the PI_SESSION_ID pi's bash left in the env is the parent", () => {
		expect(inheritedParent({ PI_SESSION_ID: PARENT }, SELF, "print")).toBe(PARENT);
		expect(inheritedParent({ PI_SESSION_ID: `  ${PARENT}\n` }, SELF, "rpc")).toBe(PARENT);
		expect(inheritedParent({ PI_SESSION_ID: PARENT }, SELF, "tui")).toBe(PARENT);
	});

	test("no parent: unset, invalid, yourself, or hosted by pi-web", () => {
		expect(inheritedParent({}, SELF, "print")).toBeUndefined();
		expect(inheritedParent({ PI_SESSION_ID: "" }, SELF, "print")).toBeUndefined();
		expect(inheritedParent({ PI_SESSION_ID: "../etc" }, SELF, "print")).toBeUndefined();
		expect(inheritedParent({ PI_SESSION_ID: SELF }, SELF, "print")).toBeUndefined();
		expect(inheritedParent({ PI_SESSION_ID: PARENT }, SELF, "web")).toBeUndefined();
	});
});

describe("no nested subs", () => {
	const GRANDPARENT = "01a15000-0000-7000-8000-000000000000";
	const records = new Map([
		[PARENT, presence({ id: PARENT, name: "scout", parent: GRANDPARENT })],
		[GRANDPARENT, presence({ id: GRANDPARENT, name: "lead" })],
	]);
	const recordOf = (id: string) => records.get(id);

	test("a pi whose inherited parent is itself a sub is refused, naming that parent", () => {
		const refusal = "nested subs aren't allowed: scout (01a152a0-f00d-72aa-a896-d904c458282b) is itself a sub. ask your parent instead.";
		expect(nestedRefusal(records.get(PARENT))).toBe(refusal);
		expect(startAs({ PI_SESSION_ID: PARENT }, SELF, "print", recordOf)).toEqual({ kind: "refuse", reason: refusal });
		expect(startAs({ PI_SESSION_ID: PARENT }, SELF, "rpc", recordOf)).toEqual({ kind: "refuse", reason: refusal });
		expect(startAs({ PI_SESSION_ID: PARENT }, SELF, "tui", recordOf).kind).toBe("refuse");
	});

	test("an unnamed sub parent is named by its id", () => {
		expect(nestedRefusal(presence({ id: "p-1", parent: "g-1" }))).toBe("nested subs aren't allowed: p-1 is itself a sub. ask your parent instead.");
	});

	test("a top-level parent's sub runs, as its sub", () => {
		expect(nestedRefusal(records.get(GRANDPARENT))).toBeUndefined();
		expect(startAs({ PI_SESSION_ID: GRANDPARENT }, SELF, "print", recordOf)).toEqual({ kind: "run", parent: GRANDPARENT });
	});

	test("a parent with no record in this store (an isolated test store) isn't known to be a sub", () => {
		expect(nestedRefusal(undefined)).toBeUndefined();
		expect(startAs({ PI_SESSION_ID: "01a15999-0000-7000-8000-000000000000" }, SELF, "print", recordOf)).toEqual({
			kind: "run",
			parent: "01a15999-0000-7000-8000-000000000000",
		});
	});

	test("no inherited parent, or hosted by pi-web: top-level, never refused", () => {
		expect(startAs({}, SELF, "print", recordOf)).toEqual({ kind: "run" });
		expect(startAs({ PI_SESSION_ID: PARENT }, SELF, "web", recordOf)).toEqual({ kind: "run" });
		expect(startAs({ PI_SESSION_ID: SELF }, SELF, "print", recordOf)).toEqual({ kind: "run" });
	});
});

describe("stopped", () => {
	test("ending mid-run, or after an aborted last run, is stopped; a finished run, or none, isn't", () => {
		const verdicts = (["none", "running", "finished", "aborted"] as const).map((run: RunState) => [run, wasStopped(run)]);
		expect(verdicts).toEqual([
			["none", false],
			["running", true],
			["finished", false],
			["aborted", true],
		]);
	});
});

describe("family", () => {
	const records = [
		presence({ id: "p", name: "boss" }),
		presence({ id: "me", parent: "p" }),
		presence({ id: "c1", parent: "me" }),
		presence({ id: "c2", parent: "me", endedAt: 5 }),
		presence({ id: "sibling", parent: "p" }),
		presence({ id: "stranger" }),
	];

	test("parent, and children whatever their state; siblings and strangers aren't family", () => {
		const family = familyOf(records, { id: "me", parent: "p" });
		expect(family.parentId).toBe("p");
		expect(family.parent?.name).toBe("boss");
		expect(family.children.map((child) => child.id)).toEqual(["c1", "c2"]);
		expect(hasFamily(family)).toBe(true);
	});

	test("a parent without a record still counts; nobody has no family", () => {
		const orphan = familyOf(records, { id: "x", parent: "gone" });
		expect(orphan.parentId).toBe("gone");
		expect(orphan.parent).toBeUndefined();
		expect(hasFamily(orphan)).toBe(true);
		expect(hasFamily(familyOf(records, { id: "stranger" }))).toBe(false);
	});

	test("relationOf", () => {
		const me = { id: "me", parent: "p" };
		expect(relationOf(me, "p", records[0])).toBe("parent");
		expect(relationOf(me, "p", undefined)).toBe("parent");
		expect(relationOf(me, "c1", records[2])).toBe("child");
		expect(relationOf(me, "sibling", records[4])).toBeUndefined();
		expect(relationOf(me, "unknown", undefined)).toBeUndefined();
	});
});

describe("watchChildren", () => {
	const now = 30 * 24 * 3_600_000;
	const alive = () => true;
	const pids = (...dead: number[]) => (pid: number) => !dead.includes(pid);
	const child = (id: string, overrides: Partial<Parameters<typeof presence>[0]> = {}) =>
		presence({ id, parent: "me", pid: 100, heartbeatAt: now, startedAt: now - 60_000, ...overrides });
	const notice = (kid: Presence, ts: number, life: Life | undefined = lifeOf(kid)) =>
		message({ to: "me", from: { id: kid.id }, kind: "died", text: "gone", ...(life ? { life } : {}) }, ts);
	const deaths = (watched: ReturnType<typeof watchChildren>) => watched.died.map((death) => [death.child.id, death.cause]);
	const ids = (records: readonly Presence[]) => records.map((record) => record.id);

	test("live children are watched; nobody died", () => {
		const watched = watchChildren([child("a"), child("b")], [], now, 0, alive);
		expect(ids(watched.watched)).toEqual(["a", "b"]);
		expect(watched.died).toEqual([]);
	});

	test("a child whose process is gone without ending died, whether or not it was ever seen live", () => {
		const crashed = child("a", { pid: 7, startedAt: now - 1_500, heartbeatAt: now - 1_500 });
		const watched = watchChildren([crashed, child("b")], [], now, 0, pids(7));
		expect(deaths(watched)).toEqual([["a", "exited"]]);
		expect(ids(watched.watched)).toEqual(["b"]);
	});

	test("once its notice exists the death is settled: not reported, not watched", () => {
		const gone = child("a", { pid: 7, heartbeatAt: now - 3_000 });
		const again = watchChildren([gone], [notice(gone, now - 1_000)], now + 2_000, 0, pids(7));
		expect(again.died).toEqual([]);
		expect(again.watched).toEqual([]);
	});

	test("a child that ended cleanly never dies, even after its process exits", () => {
		const ended = child("a", { pid: 7, endedAt: now - 1_000 });
		const watched = watchChildren([ended], [], now, 0, pids(7));
		expect(watched.died).toEqual([]);
		expect(watched.watched).toEqual([]);
	});

	test("deaths older than the window are let be, since their notice may already be pruned", () => {
		const old = child("a", { pid: 7, heartbeatAt: now - DEATH_WINDOW_MS });
		expect(watchChildren([old], [], now, 0, pids(7)).died).toEqual([]);
		const lastDay = child("a", { pid: 7, heartbeatAt: now - DEATH_WINDOW_MS + 1 });
		expect(deaths(watchChildren([lastDay], [], now, 0, pids(7)))).toEqual([["a", "exited"]]);
		expect(DELIVERED_TTL_MS - DEATH_WINDOW_MS).toBeGreaterThanOrEqual(60 * 60_000);
	});

	test("silent: a live pid that stopped heartbeating dies only after the stale window of our own waking time", () => {
		const quiet = child("a", { heartbeatAt: now - STALE_AFTER_MS - 1 });
		expect(deaths(watchChildren([quiet], [], now, 0, alive))).toEqual([["a", "silent"]]);
		const justWoke = watchChildren([quiet], [], now, now - 5_000, alive);
		expect(justWoke.died).toEqual([]);
		expect(ids(justWoke.watched)).toEqual(["a"]);
		const later = watchChildren([quiet], [], now - 5_000 + STALE_AFTER_MS + 1, now - 5_000, alive);
		expect(deaths(later)).toEqual([["a", "silent"]]);
	});

	test("a parent just started gives a days-silent child with a running pid the same grace", () => {
		const quiet = child("a", { heartbeatAt: now - 2 * 24 * 3_600_000 });
		expect(ids(watchChildren([quiet], [], now, now, alive).watched)).toEqual(["a"]);
		expect(deaths(watchChildren([quiet], [], now + STALE_AFTER_MS + 1, now, alive))).toEqual([["a", "silent"]]);
	});

	test("a child that beats again after a silent notice is live, and its next death is a new one", () => {
		const quiet = child("a", { pid: 7, heartbeatAt: now - STALE_AFTER_MS - 1 });
		const silentNotice = notice(quiet, now);
		expect(watchChildren([quiet], [silentNotice], now + 2_000, 0, alive).died).toEqual([]);
		const back = { ...quiet, heartbeatAt: now + 10_000 };
		expect(ids(watchChildren([back], [silentNotice], now + 10_000, 0, alive).watched)).toEqual(["a"]);
		expect(deaths(watchChildren([back], [silentNotice], now + 12_000, 0, pids(7)))).toEqual([["a", "exited"]]);
	});

	test("a resumed child is a new life: the last life's notice doesn't cover its death", () => {
		const first = child("a", { pid: 7, startedAt: now - 60_000, heartbeatAt: now - 50_000 });
		const firstNotice = notice(first, now - 48_000);
		const resumed = child("a", { pid: 8, startedAt: now - 20_000, heartbeatAt: now - 20_000 });
		expect(deaths(watchChildren([resumed], [firstNotice], now, 0, pids(7, 8)))).toEqual([["a", "exited"]]);
	});

	test("isNoticeOf: a died from that child, for that life, after its last heartbeat", () => {
		const gone = child("a", { pid: 7, startedAt: now - 9_000, heartbeatAt: now - 3_000 });
		expect(isNoticeOf(notice(gone, now - 3_000), gone)).toBe(true);
		expect(isNoticeOf(notice(gone, now - 3_001), gone)).toBe(false);
		expect(isNoticeOf(notice(gone, now, { pid: 7, startedAt: now - 99_000 }), gone)).toBe(false);
		expect(isNoticeOf(notice(gone, now, { pid: 6, startedAt: now - 9_000 }), gone)).toBe(false);
		expect(isNoticeOf(notice({ ...gone, id: "b" }, now), gone)).toBe(false);
		expect(isNoticeOf(message({ to: "me", from: { id: "a" }, kind: "ended", life: lifeOf(gone) }, now), gone)).toBe(false);
	});

	test("isNoticeOf: a notice without a life, from an older msg, goes by the heartbeat alone", () => {
		const gone = child("a", { pid: 7, heartbeatAt: now - 3_000 });
		expect(isNoticeOf(notice(gone, now - 1_000, undefined), gone)).toBe(true);
		expect(isNoticeOf(notice(gone, now - 5_000, undefined), gone)).toBe(false);
	});

	test("a dead child with a call older than the threshold died; it didn't stall", () => {
		const gone = child("a", { pid: 7, call: { id: "c1", name: "bash", since: now - STALLED_AFTER_MS - 60_000 } });
		const watched = watchChildren([gone], [], now, 0, pids(7));
		expect(deaths(watched)).toEqual([["a", "exited"]]);
		expect(stallsOf(watched.watched, [], now, 0)).toEqual([]);
	});

	test("diedText says what happened", () => {
		const gone = child("a", { name: "builder", pid: 7, heartbeatAt: now - 12_000 });
		expect(diedText({ child: gone, cause: "exited" }, now)).toBe(
			"builder's process (pid 7) is gone and its session never ended: it was killed or crashed. Last heartbeat 12s ago.",
		);
		expect(diedText({ child: gone, cause: "silent" }, now)).toContain("stopped responding");
	});
});

describe("which tool call can stall a sub", () => {
	const start = (id: string, overrides: Partial<CallStart> = {}): CallStart => ({ toolCallId: id, toolName: "bash", args: { command: `echo ${id}` }, ...overrides });
	const waiting = (id: string) => start(id, { toolName: "msg_send", args: { to: "parent", message: "go?", wait_seconds: 3_600 } });
	const nested = (id: string, outer: string) => start(id, { parentToolCallId: outer });
	const runs = (calls: readonly Call[]) => calls.map((call) => [call.id, call.since]);

	test("an outer call of any tool counts; msg_send and nested calls don't", () => {
		expect(canStall(start("a"))).toBe(true);
		expect(canStall(start("b", { toolName: "web_fetch", args: { url: "https://example.com" } }))).toBe(true);
		expect(canStall(waiting("c"))).toBe(false);
		expect(canStall(nested("d", "a"))).toBe(false);
		expect(canStall(start("e", { parentToolCallId: "" }))).toBe(true);
	});

	test("msg_send and nested calls are never tracked, so a sub blocked on its parent has no call to judge", () => {
		const calls = callStarted(callStarted([], waiting("w"), 1_000), nested("n", "w"), 2_000);
		expect(calls).toEqual([]);
		expect(oldestCall(calls)).toBeUndefined();
	});

	test("parallel calls: the oldest counts, and when it ends the next oldest does", () => {
		const calls = [start("a"), waiting("w"), start("b"), nested("n", "b"), start("c")].reduce<readonly Call[]>((running, call, index) => callStarted(running, call, 1_000 * (index + 1)), []);
		expect(runs(calls)).toEqual([
			["a", 1_000],
			["b", 3_000],
			["c", 5_000],
		]);
		expect(oldestCall(calls)?.id).toBe("a");
		expect(oldestCall(callEnded(calls, "b"))?.id).toBe("a");
		expect(oldestCall(callEnded(calls, "a"))?.id).toBe("b");
		expect(oldestCall(callEnded(callEnded(callEnded(calls, "a"), "b"), "c"))).toBeUndefined();
		expect(callEnded(calls, "w")).toEqual(calls);
	});

	test("a call reported twice keeps its first start", () => {
		const calls = callStarted(callStarted([], start("a"), 1_000), start("a"), 9_000);
		expect(runs(calls)).toEqual([["a", 1_000]]);
	});

	test("oldestCall goes by start, whatever the order", () => {
		const late: Call = { id: "late", name: "bash", since: 9 };
		const early: Call = { id: "early", name: "bash", since: 3 };
		expect(oldestCall([late, early])?.id).toBe("early");
		expect(oldestCall([early, { ...early, id: "tie" }])?.id).toBe("early");
	});

	test("a call is recorded with its tool's name, a preview and its start", () => {
		expect(callStarted([], start("a", { args: { command: "sleep 613" } }), 5)).toEqual([{ id: "a", name: "bash", preview: "sleep 613", since: 5 }]);
		expect(callStarted([], start("b", { toolName: "wait_for_ci", args: {} }), 5)).toEqual([{ id: "b", name: "wait_for_ci", since: 5 }]);
	});

	test("previewOf: bash's command on one line, clipped; other tools' arguments as JSON; nothing without arguments", () => {
		expect(previewOf({ command: "  npm run dev \\\n   --port 3000\n", timeout: 9 })).toBe("npm run dev \\ --port 3000");
		const long = previewOf({ command: `curl ${"x".repeat(500)}` }) ?? "";
		expect([...long].length).toBe(MAX_PREVIEW_LENGTH);
		expect(long.startsWith("curl xxx") && long.endsWith("x\u2026")).toBe(true);
		expect(previewOf({ url: "https://example.com/slow", raw: true })).toBe('{"url":"https://example.com/slow","raw":true}');
		expect(previewOf({ command: " \n " })).toBeUndefined();
		expect(previewOf({})).toBeUndefined();
		expect(previewOf(undefined)).toBeUndefined();
		expect(previewOf("sleep 1")).toBeUndefined();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(previewOf(circular)).toBeUndefined();
	});

	test("previewOf never cuts a character in half", () => {
		const preview = previewOf({ command: "\u{1F680}".repeat(300) }) ?? "";
		expect(preview).toBe(`${"\u{1F680}".repeat(MAX_PREVIEW_LENGTH - 1)}\u2026`);
	});
});

describe("stalls", () => {
	const now = 30 * 24 * 3_600_000;
	const call = (id: string, since: number, preview = "sleep 613"): Call => ({ id, name: "bash", preview, since });
	const child = (id: string, overrides: Partial<Presence> = {}) =>
		presence({ id, parent: "me", pid: 100, startedAt: now - 3_600_000, heartbeatAt: now - 2_000, activity: "busy", ...overrides });
	const stuck = (id: string, callId = "c1", since = now - STALLED_AFTER_MS - 1) => child(id, { call: call(callId, since) });
	const noticeOf = (stall: Stall, overrides: Partial<Parameters<typeof message>[0]> = {}) =>
		message({ to: "me", from: { id: stall.child.id }, kind: "stalled", text: "stuck", life: lifeOf(stall.child), call: stall.call, ...overrides }, now);
	const found = (stalls: readonly Stall[]) => stalls.map((stall) => [stall.child.id, stall.call.id]);

	test("a call that has run longer than the threshold is a stall; one that ran just that long isn't yet", () => {
		const kid = child("a", { call: call("c1", now - STALLED_AFTER_MS) });
		expect(stallsOf([kid], [], now, 0)).toEqual([]);
		expect(found(stallsOf([kid], [], now + 1, 0))).toEqual([["a", "c1"]]);
		expect(found(stallsOf([child("b", { call: call("c2", now - 4 * 3_600_000) })], [], now, 0))).toEqual([["b", "c2"]]);
	});

	test("no running call, or a record that ended: nothing to judge", () => {
		expect(stallsOf([child("a")], [], now, 0)).toEqual([]);
		expect(stallsOf([{ ...stuck("b"), endedAt: now - 1_000 }], [], now, 0)).toEqual([]);
	});

	test("the threshold is the caller's", () => {
		const kid = child("a", { call: call("c1", now - 9_000) });
		expect(stallsOf([kid], [], now, 0)).toEqual([]);
		expect(found(stallsOf([kid], [], now, 0, 8_000))).toEqual([["a", "c1"]]);
		expect(stallsOf([kid], [], now, 0, 9_000)).toEqual([]);
	});

	test("only time you were awake counts: after a sleep, or when you start, the clock restarts", () => {
		const kid = child("a", { call: call("c1", now - 2 * 3_600_000) });
		const woke = now - 60_000;
		expect(stallsOf([kid], [], now, woke)).toEqual([]);
		expect(stallsOf([kid], [], woke + STALLED_AFTER_MS, woke)).toEqual([]);
		expect(found(stallsOf([kid], [], woke + STALLED_AFTER_MS + 1, woke))).toEqual([["a", "c1"]]);
	});

	test("once per call: its notice settles it, however long the call keeps running", () => {
		const kid = stuck("a");
		const [stall] = stallsOf([kid], [], now, 0);
		if (!stall) throw new Error("expected a stall");
		expect(stallsOf([kid], [noticeOf(stall)], now, 0)).toEqual([]);
		expect(stallsOf([{ ...kid, heartbeatAt: now + 3_600_000 }], [noticeOf(stall)], now + 3_600_000, 0)).toEqual([]);
	});

	test("a later stall, on another call, is a new one", () => {
		const first = stuck("a", "c1", now - 2 * STALLED_AFTER_MS);
		const [stall] = stallsOf([first], [], now, 0);
		if (!stall) throw new Error("expected a stall");
		const later = stuck("a", "c2", now + 60_000);
		expect(stallsOf([later], [noticeOf(stall)], now + 60_000 + STALLED_AFTER_MS, 0)).toEqual([]);
		expect(found(stallsOf([later], [noticeOf(stall)], now + 60_000 + STALLED_AFTER_MS + 1, 0))).toEqual([["a", "c2"]]);
	});

	test("each stalled child is judged on its own", () => {
		const a = stuck("a");
		const [stallA] = stallsOf([a], [], now, 0);
		if (!stallA) throw new Error("expected a stall");
		expect(found(stallsOf([a, stuck("b"), child("c")], [noticeOf(stallA)], now, 0))).toEqual([["b", "c1"]]);
	});

	test("isStallNoticeOf: a stalled from that child, for that life and that call", () => {
		const stall: Stall = { child: stuck("a"), call: call("c1", now - STALLED_AFTER_MS - 1) };
		expect(isStallNoticeOf(noticeOf(stall), stall)).toBe(true);
		expect(isStallNoticeOf(noticeOf(stall, { kind: "died" }), stall)).toBe(false);
		expect(isStallNoticeOf(noticeOf(stall, { from: { id: "b" } }), stall)).toBe(false);
		expect(isStallNoticeOf(noticeOf(stall, { life: { pid: 101, startedAt: stall.child.startedAt } }), stall)).toBe(false);
		expect(isStallNoticeOf(noticeOf(stall, { life: { pid: 100, startedAt: 1 } }), stall)).toBe(false);
		expect(isStallNoticeOf(noticeOf(stall, { call: { ...stall.call, id: "c2" } }), stall)).toBe(false);
		expect(isStallNoticeOf(noticeOf(stall, { call: { ...stall.call, since: stall.call.since + 1 } }), stall)).toBe(false);
		const { life: _life, ...lifeless } = noticeOf(stall);
		expect(isStallNoticeOf(lifeless, stall)).toBe(false);
		const { call: _call, ...callless } = noticeOf(stall);
		expect(isStallNoticeOf(callless, stall)).toBe(false);
	});

	test("a stall older than the window is let be, since its notice may already be pruned", () => {
		expect(stallsOf([stuck("a", "c1", now - DEATH_WINDOW_MS)], [], now, 0)).toEqual([]);
		expect(found(stallsOf([stuck("a", "c1", now - DEATH_WINDOW_MS + 1)], [], now, 0))).toEqual([["a", "c1"]]);
	});

	test("stalledAfter: PI_MSG_STALLED_AFTER_MS when it's a positive integer of ms, else 10 minutes", () => {
		expect(STALLED_AFTER_MS).toBe(10 * 60_000);
		expect(stalledAfter({})).toBe(STALLED_AFTER_MS);
		expect(stalledAfter({ PI_MSG_STALLED_AFTER_MS: "8000" })).toBe(8_000);
		expect(stalledAfter({ PI_MSG_STALLED_AFTER_MS: " 1\n" })).toBe(1);
		for (const junk of ["", " ", "0", "-5", "1.5", "8e3", "0x10", "abc", "8000ms", "99999999999999999999"]) {
			expect([junk, stalledAfter({ PI_MSG_STALLED_AFTER_MS: junk })]).toEqual([junk, STALLED_AFTER_MS]);
		}
	});

	test("stopCommand: SIGTERM to the sub's pi, which takes its running commands down with it", () => {
		expect(stopCommand(stuck("a"))).toBe("kill 100");
	});

	test("stalledText: what it's stuck in, for how long and since when, that it's alive, how to stop it, and that it may be left", () => {
		const kid = child("a", { name: "builder", pid: 4242, heartbeatAt: now - 3_000 });
		expect(stalledText({ child: kid, call: call("c1", now - 12 * 60_000, "npm run dev -- --port 3000") }, now)).toBe(
			[
				"builder has been stuck in one tool call for 12m, since 1970-01-30T23:48:00Z:",
				"bash: npm run dev -- --port 3000",
				"It's alive (pid 4242, last heartbeat 3s ago) but can't go on until that call returns.",
				"To stop it, run `kill 4242`: pi kills the commands it's running (each one's whole process group) and ends, and builder reports ended, stopped, with its last words.",
				"Or leave it, if that's a legit long command: you won't hear about this call again.",
			].join("\n"),
		);
	});

	test("stalledText: a call without a preview is named by its tool alone", () => {
		const text = stalledText({ child: child("a"), call: { id: "c1", name: "wait_for_ci", since: now - 3 * 3_600_000 } }, now);
		expect(text.split("\n").slice(0, 2)).toEqual(["a has been stuck in one tool call for 3h, since 1970-01-30T21:00:00Z:", "wait_for_ci"]);
	});
});

describe("last words", () => {
	const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ role: "assistant", content, ...extra });
	const entry = (message: unknown) => ({ type: "message", id: "e", message });

	/** What pi records when a run is aborted mid-tool (Esc, an rpc abort): an error, not `aborted`. */
	const abortedMidTool = assistant([], { stopReason: "error", errorMessage: "This operation was aborted" });

	test("noteWords: an assistant text replaces the words; a message without text keeps them and says why", () => {
		const said = noteWords({}, assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: " done " }, { type: "text", text: "really" }]));
		expect(said).toEqual({ text: "done \nreally" });
		expect(noteWords(said, assistant([], { stopReason: "error", errorMessage: " overloaded " }))).toEqual({ text: "done \nreally", failure: "overloaded" });
		expect(noteWords(said, abortedMidTool)).toEqual({ text: "done \nreally", failure: "This operation was aborted" });
		expect(noteWords(said, assistant([{ type: "text", text: "Half a thou" }], { stopReason: "aborted" }))).toEqual({ text: "Half a thou" });
		expect(noteWords(said, assistant([{ type: "toolCall", name: "bash" }]))).toEqual(said);
		expect(noteWords({ text: "a", failure: "overloaded" }, assistant([{ type: "toolCall", name: "bash" }]))).toEqual({ text: "a" });
		expect(noteWords({}, abortedMidTool)).toEqual({ failure: "This operation was aborted" });
		expect(noteWords(said, { role: "user", content: [{ type: "text", text: "hi" }] })).toBe(said);
		expect(noteWords(said, { role: "toolResult", content: [{ type: "text", text: "Command aborted" }] })).toBe(said);
		expect(noteWords(said, null)).toBe(said);
	});

	test("wordsIn folds a branch, skipping users, tool-only messages and custom entries", () => {
		const entries = [
			entry(assistant([{ type: "text", text: "first" }])),
			entry(assistant([{ type: "text", text: "the report" }])),
			entry({ role: "user", content: [{ type: "text", text: "later user text" }] }),
			entry(assistant([{ type: "toolCall", name: "msg_send" }])),
			{ type: "custom_message", customType: "msg", content: "x" },
		];
		expect(wordsIn(entries)).toEqual({ text: "the report" });
		expect(wordsIn([...entries, entry(abortedMidTool)])).toEqual({ text: "the report", failure: "This operation was aborted" });
		expect(wordsIn([])).toEqual({});
	});

	test("reportWords: a stopped sub says its newest text, never the stop's own error; a failed run says its error", () => {
		const aborted = noteWords(noteWords({}, assistant([{ type: "text", text: "Running the migration tests now." }])), abortedMidTool);
		expect(reportWords(aborted, true)).toBe("Running the migration tests now.");
		expect(reportWords(noteWords({}, abortedMidTool), true)).toBeUndefined();
		expect(reportWords({ text: "Starting.", failure: "overloaded" }, false)).toBe("(failed with an error: overloaded)");
		expect(reportWords({ text: "all green" }, false)).toBe("all green");
		expect(reportWords({ text: "all green" }, true)).toBe("all green");
		expect(reportWords({}, false)).toBeUndefined();
	});

	test("endedText: the whole final message, however long, up to msg's message limit", () => {
		expect(endedText("  all green  ", SELF)).toBe("all green");
		expect(endedText(undefined, SELF)).toBe("(it ended without a final message)");
		const report = `${"finding: the parser drops a trailing comma\n".repeat(150)}end of report`;
		expect(report.length).toBeGreaterThan(6_000);
		expect(endedText(report, SELF)).toBe(report);
		const atLimit = "x".repeat(MAX_TEXT_BYTES);
		expect(endedText(atLimit, SELF)).toBe(atLimit);
	});

	test("endedText: past the limit it's cut at a word, points at the rest, and still fits in a message", () => {
		const long = `${"word ".repeat(MAX_TEXT_BYTES / 4)}end`;
		const cut = endedText(long, SELF);
		expect(textBytes(cut)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
		expect(textBytes(cut)).toBeGreaterThan(MAX_TEXT_BYTES - 200);
		expect(cut).toMatch(/word… \[\+\d+ chars: lookup last 01a152d4-d2c3-751d-ab2f-1d14f1974871 -k assistant --full\]$/);
		const rest = Number(/\[\+(\d+) chars/.exec(cut)?.[1]);
		expect(cut.indexOf("…") + rest).toBe(long.length);
		expect(createMessage({ from: { id: SELF }, to: PARENT, text: cut, kind: "ended" }, 1).ok).toBe(true);
	});

	test("endedText: multibyte text is cut by bytes, never through a character", () => {
		const emoji = "🚀".repeat(MAX_TEXT_BYTES / 2);
		const cut = endedText(emoji, SELF);
		expect(textBytes(cut)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
		expect(cut).not.toContain("\uFFFD");
		const head = cut.slice(0, cut.indexOf("…"));
		expect(head).toBe("🚀".repeat(head.length / 2));
		expect(head.length).toBeGreaterThan(0);
	});
});
