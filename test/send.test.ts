import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeLive, expectation, formatDirectory, tildify } from "../src/core/format.ts";
import { peek } from "../src/core/maildir.ts";
import { directory, writePresence } from "../src/core/registry.ts";
import type { Target } from "../src/core/resolve.ts";
import { canAnswer, findRecipient, post } from "../src/core/send.ts";
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
		expect(found.ok && found.value.presence.id).toBe("you-1");
		expect(findRecipient(root, self, "main", now, alive)).toEqual({ ok: false, error: '"main" is you' });
		expect(findRecipient(root, self, "me-1", now, alive)).toEqual({ ok: false, error: '"me-1" is you' });
	});

	test("prefers another session that shares my name", () => {
		const now = Date.now();
		writePresence(root, presence({ id: "me-1", name: "twin", heartbeatAt: now }));
		writePresence(root, presence({ id: "you-1", name: "twin", heartbeatAt: now }));
		const found = findRecipient(root, { id: "me-1", name: "twin" }, "twin", now, alive);
		expect(found.ok && found.value.presence.id).toBe("you-1");
	});
});

describe("post", () => {
	test("drops the message in the recipient's inbox", () => {
		const target: Target = { presence: presence({ id: "you-1" }), live: true, via: "name" };
		const posted = post(root, { id: "me-1", name: "main" }, target, { text: "hi", delivery: "followUp", awaitingUntil: 99 }, 5);
		expect(posted.ok).toBe(true);
		const inbox = peek(root, "you-1");
		expect(inbox.length).toBe(1);
		const [entry] = inbox;
		expect(entry?.kind === "message" && [entry.message.text, entry.message.delivery, entry.message.awaitingUntil, entry.message.from.name]).toEqual(["hi", "followUp", 99, "main"]);
	});

	test("rejects an empty message without touching the inbox", () => {
		const target: Target = { presence: presence({ id: "you-1" }), live: true, via: "name" };
		expect(post(root, { id: "me-1" }, target, { text: " " }, 5).ok).toBe(false);
		expect(peek(root, "you-1")).toEqual([]);
	});
});

describe("canAnswer", () => {
	const target = (overrides: Parameters<typeof presence>[0], live = true): Target => ({ presence: presence(overrides), live, via: "name" });

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

	test("expectation explains when the message lands", () => {
		const now = 1_000_000;
		const of = (overrides: Parameters<typeof presence>[0], live = true): Target => ({ presence: presence({ heartbeatAt: now, ...overrides }), live, via: "name" });
		expect(expectation(of({ id: "a", activity: "busy" }), "steer", now)).toContain("next step");
		expect(expectation(of({ id: "a", activity: "busy" }), "followUp", now)).toContain("current task is done");
		expect(expectation(of({ id: "a", activity: "idle" }), "steer", now)).toContain("wakes up");
		expect(expectation(of({ id: "a", activity: "idle", mode: "print" }), "steer", now)).toContain("about to exit");
		expect(expectation(of({ id: "a", heartbeatAt: now - 7_200_000 }, false), "steer", now)).toContain("offline (last seen 2h ago)");
		expect(expectation(of({ id: "a", mode: "cli" }, false), "steer", now)).toContain("msg inbox");
	});
});
