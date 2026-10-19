import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeLive, describeOffline, expectation, formatDirectory, targetLabel, tildify } from "../src/core/format.ts";
import { peek } from "../src/core/maildir.ts";
import { directory, writePresence } from "../src/core/registry.ts";
import type { Target } from "../src/core/resolve.ts";
import { canAnswer, findRecipient, liveChildren, post, postExit } from "../src/core/send.ts";
import { presence, tempRoot } from "./helpers.ts";

let root = "";
let cleanup = () => {};

beforeEach(() => {
	({ root, cleanup } = tempRoot());
});

afterEach(() => cleanup());

const alive = () => true;

describe("findRecipient", () => {
	test("never resolves to the sender, and says so", () => {
		const now = Date.now();
		writePresence(root, presence({ id: "me-1", name: "main", heartbeatAt: now, pid: process.pid }));
		writePresence(root, presence({ id: "you-1", name: "builder", heartbeatAt: now, pid: process.pid }));
		const self = { id: "me-1", name: "main" };
		const found = findRecipient(root, self, "builder", now, alive);
		expect(found.ok && found.value.id).toBe("you-1");
		expect(findRecipient(root, self, "main", now, alive)).toEqual({ ok: false, error: '"main" is you' });
		expect(findRecipient(root, self, "me-1", now, alive)).toEqual({ ok: false, error: '"me-1" is you' });
	});

	test("a folder only I work in is me; one I share finds the other session", () => {
		const now = Date.now();
		const lookup = { home: "/home/u" };
		writePresence(root, presence({ id: "me-1", cwd: "/repo", heartbeatAt: now }));
		const self = { id: "me-1", cwd: "/repo" };
		expect(findRecipient(root, self, "./", now, alive, lookup)).toEqual({ ok: false, error: '"./" is you' });
		expect(findRecipient(root, self, "/repo", now, alive, lookup)).toEqual({ ok: false, error: '"/repo" is you' });
		writePresence(root, presence({ id: "you-1", cwd: "/repo", heartbeatAt: now }));
		const found = findRecipient(root, self, ".", now, alive, lookup);
		expect(found.ok && found.value.id).toBe("you-1");
	});

	test("prefers another session that shares my name", () => {
		const now = Date.now();
		writePresence(root, presence({ id: "me-1", name: "twin", heartbeatAt: now }));
		writePresence(root, presence({ id: "you-1", name: "twin", heartbeatAt: now }));
		const found = findRecipient(root, { id: "me-1", name: "twin" }, "twin", now, alive);
		expect(found.ok && found.value.id).toBe("you-1");
	});
});

describe("post", () => {
	test("drops the message in the recipient's inbox", () => {
		const target: Target = { id: "you-1", presence: presence({ id: "you-1" }), live: true, via: "name" };
		const posted = post(root, { id: "me-1", name: "main" }, target, { text: "hi", delivery: "followUp", awaitingUntil: 99 }, 5);
		expect(posted.ok).toBe(true);
		const inbox = peek(root, "you-1");
		expect(inbox.length).toBe(1);
		const [entry] = inbox;
		expect(entry?.kind === "message" && [entry.message.text, entry.message.delivery, entry.message.awaitingUntil, entry.message.from.name]).toEqual(["hi", "followUp", 99, "main"]);
	});

	test("rejects an empty message without touching the inbox", () => {
		const target: Target = { id: "you-1", presence: presence({ id: "you-1" }), live: true, via: "name" };
		expect(post(root, { id: "me-1" }, target, { text: " " }, 5).ok).toBe(false);
		expect(peek(root, "you-1")).toEqual([]);
	});
});

describe("lineage sends", () => {
	test("liveChildren: only my children, only live ones", () => {
		const now = Date.now();
		writePresence(root, presence({ id: "k-1", parent: "me", heartbeatAt: now }));
		writePresence(root, presence({ id: "k-2", parent: "me", heartbeatAt: now, endedAt: now }));
		writePresence(root, presence({ id: "k-3", parent: "someone-else", heartbeatAt: now }));
		expect(liveChildren(root, "me", now, alive).map((target) => [target.id, target.via])).toEqual([["k-1", "children"]]);
		expect(liveChildren(root, "nobody", now, alive)).toEqual([]);
	});

	test("post marks byUser; a parent without a record still gets the mail", () => {
		const target: Target = { id: "boss-1", live: false, via: "parent" };
		const posted = post(root, { id: "me-1" }, target, { text: "stop", byUser: true }, 5);
		expect(posted.ok && posted.value.byUser).toBe(true);
		const [entry] = peek(root, "boss-1");
		expect(entry?.kind === "message" && entry.message.byUser).toBe(true);
		expect(canAnswer(target)).toBe(false);
	});

	test("postExit drops an ended or died notice from the child", () => {
		const ended = postExit(root, { id: "k-1", name: "kid", cwd: "/f/1" }, "boss-1", "ended", "all done", 9);
		expect(ended.ok && [ended.value.kind, ended.value.to, ended.value.from.id, ended.value.text]).toEqual(["ended", "boss-1", "k-1", "all done"]);
		const died = postExit(root, { id: "k-2" }, "boss-1", "died", "gone", 10);
		expect(died.ok && died.value.kind).toBe("died");
		expect(peek(root, "boss-1").map((entry) => (entry.kind === "message" ? entry.message.kind : "?"))).toEqual(["ended", "died"]);
	});
});

describe("canAnswer", () => {
	const target = (overrides: Parameters<typeof presence>[0], live = true): Target => ({ id: overrides.id, presence: presence(overrides), live, via: "name" });

	test("an idle headless run is finishing; everything else live can answer", () => {
		expect(canAnswer(target({ id: "a", mode: "print", activity: "idle" }))).toBe(false);
		expect(canAnswer(target({ id: "a", mode: "json", activity: "idle" }))).toBe(false);
		expect(canAnswer(target({ id: "a", mode: "print", activity: "busy" }))).toBe(true);
		expect(canAnswer(target({ id: "a", mode: "tui", activity: "idle" }))).toBe(true);
		expect(canAnswer(target({ id: "a", mode: "tui" }, false))).toBe(false);
	});
});

describe("format", () => {
	test("tildify only shortens real home prefixes", () => {
		expect(tildify("/home/u/x", "/home/u")).toBe("~/x");
		expect(tildify("/home/u", "/home/u")).toBe("~");
		expect(tildify("/home/user2/x", "/home/u")).toBe("/home/user2/x");
	});

	test("describeLive shows name, id, mode, activity, cwd and uptime", () => {
		const line = describeLive(presence({ id: "b-1", name: "builder", mode: "print", activity: "busy", cwd: "/home/u/repo", startedAt: 0 }), 4 * 60_000, "/home/u");
		expect(line).toBe("builder · b-1 · print · busy · ~/repo · up 4m");
	});

	test("formatDirectory leaves out the caller and counts hidden offline sessions", () => {
		const now = 100_000;
		const self = presence({ id: "me", name: "main", heartbeatAt: now });
		const dir = directory([self, presence({ id: "b", name: "builder", heartbeatAt: now }), presence({ id: "old", heartbeatAt: 1 })], now, alive);
		const text = formatDirectory(dir, self, now, "/home/u", { all: false, maxOffline: 5 });
		expect(text).toContain("you: main · me");
		expect(text).toContain("1 live:\n- builder · b");
		expect(text).toContain("(1 offline not shown)");
		expect(formatDirectory(dir, self, now, "/home/u", { all: true, maxOffline: 5 })).toContain("1 offline (they get messages when they resume):\n- (unnamed) · old");
	});

	test("describeOffline says ended or offline, and when", () => {
		const ended = presence({ id: "e-1", name: "kid", mode: "print", cwd: "/home/u/f", heartbeatAt: 0, endedAt: 3 * 60_000 });
		expect(describeOffline(ended, 5 * 60_000, "/home/u")).toBe("kid · e-1 · print · ended · ~/f · 2m ago");
		expect(describeOffline({ ...ended, endedAt: undefined }, 5 * 60_000, "/home/u")).toBe("kid · e-1 · print · offline · ~/f · last seen 5m ago");
	});

	test("formatDirectory: a session with family sees itself, its parent and children first", () => {
		const now = 600_000;
		const self = presence({ id: "me", name: "main", parent: "boss", heartbeatAt: now, cwd: "/home/u/repo" });
		const records = [
			self,
			presence({ id: "boss", name: "orchestrator", mode: "web", heartbeatAt: now, startedAt: 0, cwd: "/home/u" }),
			presence({ id: "k-1", name: "api", parent: "me", mode: "print", activity: "busy", heartbeatAt: now, startedAt: now - 60_000, cwd: "/home/u/repo/.forks/1" }),
			presence({ id: "k-2", name: "db", parent: "me", mode: "print", heartbeatAt: 0, endedAt: now - 120_000, cwd: "/home/u/repo/.forks/2" }),
			presence({ id: "x", name: "stranger", heartbeatAt: now }),
		];
		const dir = directory(records, now, alive);
		const text = formatDirectory(dir, self, now, "/home/u", { all: false, maxOffline: 5 });
		expect(text.split("\n")).toEqual([
			"you: main · me · tui · ~/repo",
			"parent: orchestrator · boss · web · idle · ~ · up 10m",
			"children: 2 (1 live)",
			"- api · k-1 · print · busy · ~/repo/.forks/1 · up 60s",
			"- db · k-2 · print · ended · ~/repo/.forks/2 · 2m ago",
			"(1 other live session: all: true lists everyone)",
		]);
		const all = formatDirectory(dir, self, now, "/home/u", { all: true, maxOffline: 5 });
		expect(all).toContain("3 live:");
		expect(all).toContain("- orchestrator · boss · web · idle · ~ · up 10m (your parent)");
		expect(all).toContain("- api · k-1 · print · busy · ~/repo/.forks/1 · up 60s (your child)");
		expect(all).toContain("1 offline (they get messages when they resume):\n- db · k-2 · print · ended · ~/repo/.forks/2 · 2m ago (your child)");
	});

	test("formatDirectory: a parent with no record, a parent with no children", () => {
		const now = 600_000;
		const self = presence({ id: "me", name: "main", parent: "ghost", heartbeatAt: now });
		const text = formatDirectory(directory([self], now, alive), self, now, "/home/u", { all: false, maxOffline: 5 });
		expect(text).toContain("parent: ghost (never ran msg: no presence record; mail waits in its inbox)");
		expect(text).toContain("no children.");
	});

	test("expectation and label for a parent that never ran msg", () => {
		const target: Target = { id: "boss-1", live: false, via: "parent" };
		expect(expectation(target, "steer", 0)).toContain("never run msg");
		expect(targetLabel(target)).toBe("your parent (boss-1)");
	});

	test("expectation explains when the message lands", () => {
		const now = 1_000_000;
		const of = (overrides: Parameters<typeof presence>[0], live = true): Target => ({ id: overrides.id, presence: presence({ heartbeatAt: now, ...overrides }), live, via: "name" });
		expect(expectation(of({ id: "a", activity: "busy" }), "steer", now)).toContain("next step");
		expect(expectation(of({ id: "a", activity: "busy" }), "followUp", now)).toContain("current task is done");
		expect(expectation(of({ id: "a", activity: "idle" }), "steer", now)).toContain("wakes up");
		expect(expectation(of({ id: "a", activity: "idle", mode: "print" }), "steer", now)).toContain("about to exit");
		expect(expectation(of({ id: "a", heartbeatAt: now - 7_200_000 }, false), "steer", now)).toContain("offline (last seen 2h ago)");
		expect(expectation(of({ id: "a", mode: "cli" }, false), "steer", now)).toContain("msg inbox");
	});
});
