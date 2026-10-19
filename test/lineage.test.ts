import { describe, expect, test } from "bun:test";
import {
	assistantWords,
	diedText,
	endedText,
	familyOf,
	hasFamily,
	inheritedParent,
	LAST_WORDS_MAX,
	lastWordsIn,
	relationOf,
	watchChildren,
} from "../src/core/lineage.ts";
import { STALE_AFTER_MS } from "../src/core/registry.ts";
import { presence } from "./helpers.ts";

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
	const now = 1_000_000;
	const alive = () => true;
	const pids = (...dead: number[]) => (pid: number) => !dead.includes(pid);
	const child = (id: string, overrides: Partial<Parameters<typeof presence>[0]> = {}) =>
		presence({ id, parent: "me", pid: 100, heartbeatAt: now, startedAt: now - 60_000, ...overrides });

	test("live children join the watch", () => {
		const watched = watchChildren([child("a"), child("b")], new Set(), now, 0, alive);
		expect([...watched.seen].sort()).toEqual(["a", "b"]);
		expect(watched.died).toEqual([]);
	});

	test("a watched child whose process is gone without ending died, once", () => {
		const gone = child("a", { pid: 7, heartbeatAt: now - 3_000 });
		const first = watchChildren([gone], new Set(["a"]), now, 0, pids(7));
		expect(first.died.map((death) => [death.child.id, death.cause])).toEqual([["a", "exited"]]);
		expect(first.seen.has("a")).toBe(false);
		const again = watchChildren([gone], first.seen, now + 2_000, 0, pids(7));
		expect(again.died).toEqual([]);
	});

	test("a child that ended cleanly never dies, even after its process exits", () => {
		const ended = child("a", { pid: 7, endedAt: now - 1_000 });
		const watched = watchChildren([ended], new Set(["a"]), now, 0, pids(7));
		expect(watched.died).toEqual([]);
		expect(watched.seen.size).toBe(0);
	});

	test("a child never seen live is never reported", () => {
		const old = child("a", { pid: 7, heartbeatAt: now - 3_600_000 });
		expect(watchChildren([old], new Set(), now, 0, pids(7)).died).toEqual([]);
		expect(watchChildren([old], new Set(), now, 0, alive).seen.size).toBe(0);
	});

	test("silent: a live pid that stopped heartbeating dies only after the stale window of our own waking time", () => {
		const quiet = child("a", { heartbeatAt: now - STALE_AFTER_MS - 1 });
		expect(watchChildren([quiet], new Set(["a"]), now, 0, alive).died.map((death) => death.cause)).toEqual(["silent"]);
		const justWoke = watchChildren([quiet], new Set(["a"]), now, now - 5_000, alive);
		expect(justWoke.died).toEqual([]);
		expect(justWoke.seen.has("a")).toBe(true);
		const later = watchChildren([quiet], justWoke.seen, now - 5_000 + STALE_AFTER_MS + 1, now - 5_000, alive);
		expect(later.died.map((death) => death.cause)).toEqual(["silent"]);
	});

	test("children that vanish from the registry leave the watch quietly", () => {
		const watched = watchChildren([], new Set(["a"]), now, 0, alive);
		expect(watched.seen.size).toBe(0);
		expect(watched.died).toEqual([]);
	});

	test("a resumed child is watched again, so its next death is reported too", () => {
		const back = child("a", { pid: 8, startedAt: now });
		const watched = watchChildren([back], new Set(), now, 0, alive);
		expect(watched.seen.has("a")).toBe(true);
		const dead = watchChildren([{ ...back, heartbeatAt: now }], watched.seen, now + 4_000, 0, pids(8));
		expect(dead.died.length).toBe(1);
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
