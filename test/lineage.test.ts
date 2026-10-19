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
	LAST_WORDS_MAX,
	lastWordsIn,
	lifeOf,
	relationOf,
	watchChildren,
} from "../src/core/lineage.ts";
import type { Life } from "../src/core/message.ts";
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
		expect(inheritedParent({ PI_SESSION_ID: PARENT }, SELF, "cli")).toBeUndefined();
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
		expect(assistantWords(assistant([], { stopReason: "error", errorMessage: "overloaded" }))).toBe("(stopped with an error: overloaded)");
		expect(assistantWords(assistant([{ type: "toolCall", name: "bash" }]))).toBeUndefined();
		expect(assistantWords({ role: "user", content: [{ type: "text", text: "hi" }] })).toBeUndefined();
		expect(assistantWords(null)).toBeUndefined();
	});

	test("lastWordsIn skips tool-only messages, users and custom entries", () => {
		const entries = [
			entry(assistant([{ type: "text", text: "first" }])),
			entry(assistant([{ type: "text", text: "the report" }])),
			entry({ role: "user", content: [{ type: "text", text: "later user text" }] }),
			entry(assistant([{ type: "toolCall", name: "msg_send" }])),
			{ type: "custom_message", customType: "msg", content: "x" },
		];
		expect(lastWordsIn(entries)).toBe("the report");
		expect(lastWordsIn([])).toBeUndefined();
	});

	test("endedText keeps short words, cuts long ones at a word and points at the rest", () => {
		expect(endedText("  all green  ", SELF)).toBe("all green");
		expect(endedText(undefined, SELF)).toBe("(it ended without a final message)");
		const long = `${"word ".repeat(200)}end`;
		const cut = endedText(long, SELF);
		expect(cut.length).toBeLessThan(LAST_WORDS_MAX + 100);
		expect(cut).toMatch(/word… \[\+\d+ chars: lookup last 01a152d4-d2c3-751d-ab2f-1d14f1974871 -k assistant --full\]$/);
		expect(endedText("x".repeat(LAST_WORDS_MAX + 50), SELF)).toStartWith(`${"x".repeat(LAST_WORDS_MAX)}…`);
	});
});
