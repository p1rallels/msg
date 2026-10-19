import { describe, expect, test } from "bun:test";
import { DELIVERED_TTL_MS } from "../src/core/housekeeping.ts";
import {
	assistantWords,
	DEATH_WINDOW_MS,
	diedText,
	endedText,
	familyOf,
	hasFamily,
	inheritedParent,
	isNoticeOf,
	lastWordsIn,
	lifeOf,
	nestedRefusal,
	relationOf,
	type RunState,
	startAs,
	wasStopped,
	watchChildren,
} from "../src/core/lineage.ts";
import { createMessage, type Life, MAX_TEXT_BYTES, textBytes } from "../src/core/message.ts";
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

	test("diedText says what happened", () => {
		const gone = child("a", { name: "builder", pid: 7, heartbeatAt: now - 12_000 });
		expect(diedText({ child: gone, cause: "exited" }, now)).toBe(
			"builder's process (pid 7) is gone and its session never ended: it was killed or crashed. Last heartbeat 12s ago.",
		);
		expect(diedText({ child: gone, cause: "silent" }, now)).toContain("stopped responding");
	});
});

describe("last words", () => {
	const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ role: "assistant", content, ...extra });
	const entry = (message: unknown) => ({ type: "message", id: "e", message });

	test("assistantWords: text parts joined, else the error, else nothing", () => {
		expect(assistantWords(assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: " done " }, { type: "text", text: "really" }]))).toBe(
			"done \nreally",
		);
		expect(assistantWords(assistant([], { stopReason: "error", errorMessage: "overloaded" }))).toBe("(failed with an error: overloaded)");
		expect(assistantWords(assistant([], { stopReason: "aborted", errorMessage: "This operation was aborted" }))).toBeUndefined();
		expect(assistantWords(assistant([{ type: "text", text: "Half a thou" }], { stopReason: "aborted" }))).toBe("Half a thou");
		expect(assistantWords(assistant([{ type: "toolCall", name: "bash" }]))).toBeUndefined();
		expect(assistantWords({ role: "user", content: [{ type: "text", text: "hi" }] })).toBeUndefined();
		expect(assistantWords(null)).toBeUndefined();
	});

	test("lastWordsIn skips tool-only messages, aborted empties, users and custom entries", () => {
		const entries = [
			entry(assistant([{ type: "text", text: "first" }])),
			entry(assistant([{ type: "text", text: "the report" }])),
			entry({ role: "user", content: [{ type: "text", text: "later user text" }] }),
			entry(assistant([{ type: "toolCall", name: "msg_send" }])),
			entry(assistant([], { stopReason: "aborted", errorMessage: "This operation was aborted" })),
			{ type: "custom_message", customType: "msg", content: "x" },
		];
		expect(lastWordsIn(entries)).toBe("the report");
		expect(lastWordsIn([])).toBeUndefined();
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
