import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeLive, describeOffline, expectation, formatDirectory, headline, replyText, targetLabel, tildify } from "../src/core/format.ts";
import { directory, type Presence, writePresence } from "../src/core/registry.ts";
import type { Asker, Target } from "../src/core/resolve.ts";
import { canAnswer, findRecipients, post, postExit, recipients, senderOf } from "../src/core/send.ts";
import { message, presence, tempRoot, waiting } from "./helpers.ts";

let root = "";
let cleanup = () => {};

beforeEach(() => {
	({ root, cleanup } = tempRoot());
});

afterEach(() => cleanup());

const alive = () => true;
const lookup = { home: "/home/u" };
const NOW = 1_000_000;

/**
 * lead (top-level, in /repo) started scout and fixer; boss (top-level) started its own worker; loner is top-level
 * with no subs. scout's old sibling ended.
 */
const world: Presence[] = [
	presence({ id: "lead-1", name: "lead", cwd: "/repo", heartbeatAt: NOW }),
	presence({ id: "scout-1", name: "scout", parent: "lead-1", cwd: "/repo/.forks/1", mode: "print", activity: "busy", heartbeatAt: NOW }),
	presence({ id: "fixer-1", name: "fixer", parent: "lead-1", cwd: "/repo/.forks/2", mode: "print", activity: "busy", heartbeatAt: NOW }),
	presence({ id: "old-1", name: "old", parent: "lead-1", cwd: "/repo/.forks/3", mode: "print", heartbeatAt: NOW - 60_000, endedAt: NOW - 60_000 }),
	presence({ id: "boss-1", name: "boss", cwd: "/other", mode: "web", heartbeatAt: NOW }),
	presence({ id: "worker-1", name: "worker", parent: "boss-1", cwd: "/other/.forks/1", mode: "print", activity: "busy", heartbeatAt: NOW }),
	presence({ id: "loner-1", name: "loner", cwd: "/solo", heartbeatAt: NOW }),
];

const asker = (id: string): Asker => {
	const record = world.find((candidate) => candidate.id === id);
	if (!record) throw new Error(`no ${id}`);
	return record;
};

const reach = (from: string, query: string): string => {
	const result = recipients(query, world, asker(from), NOW, alive, lookup);
	return result.ok ? result.value.map((target) => `${target.id}:${target.via}`).join(",") : `error:${result.error}`;
};

describe("the tree is a wall: a sub reaches only its parent", () => {
	test("by parent, its exact id, its live name or its folder", () => {
		expect(reach("scout-1", "parent")).toBe("lead-1:parent");
		expect(reach("scout-1", "lead-1")).toBe("lead-1:id");
		expect(reach("scout-1", "lead")).toBe("lead-1:name");
		expect(reach("scout-1", "/repo")).toBe("lead-1:folder");
	});

	test("anything else is refused with one line that says to use parent", () => {
		const refusal = `error:you're lead's sub: you can message only your parent (to: "parent")`;
		for (const query of ["fixer", "fixer-1", "/repo/.forks/2", "boss", "worker-1", "loner", "old-1", "scout", "nobody", "lea", "children", "Children"]) {
			expect(reach("scout-1", query)).toBe(refusal);
		}
		expect(refusal).not.toContain("\n");
	});

	test("a sub whose parent never ran msg still reaches it, and only it", () => {
		const orphan = { id: "orphan-1", parent: "ghost-1", cwd: "/x" };
		const result = recipients("parent", world, orphan, NOW, alive, lookup);
		expect(result.ok && result.value.map((target) => [target.id, target.live, target.presence])).toEqual([["ghost-1", false, undefined]]);
		const refused = recipients("loner", world, orphan, NOW, alive, lookup);
		expect(refused.ok ? "" : refused.error).toBe(`you're ghost-1's sub: you can message only your parent (to: "parent")`);
	});
});

describe("the tree is a wall: only a sub's parent may message it", () => {
	test("its parent reaches it by exact id, live name or folder, ended or live", () => {
		expect(reach("lead-1", "scout")).toBe("scout-1:name");
		expect(reach("lead-1", "scout-1")).toBe("scout-1:id");
		expect(reach("lead-1", "/repo/.forks/2")).toBe("fixer-1:folder");
		expect(reach("lead-1", "old-1")).toBe("old-1:id");
	});

	test("anyone else is refused: <sub> is <parent>'s sub: message <parent>", () => {
		expect(reach("loner-1", "scout")).toBe("error:scout (scout-1) is lead's sub: message lead (lead-1)");
		expect(reach("loner-1", "scout-1")).toBe("error:scout (scout-1) is lead's sub: message lead (lead-1)");
		expect(reach("boss-1", "/repo/.forks/1")).toBe("error:scout (scout-1) is lead's sub: message lead (lead-1)");
		expect(reach("boss-1", "old-1")).toBe("error:old (old-1) is lead's sub: message lead (lead-1)");
		expect(reach("lead-1", "worker")).toBe("error:worker (worker-1) is boss's sub: message boss (boss-1)");
	});

	test("a sub whose parent has no record names the parent by its exact id", () => {
		const records = [...world, presence({ id: "stray-1", name: "stray", parent: "gone-1", heartbeatAt: NOW })];
		const result = recipients("stray", records, asker("loner-1"), NOW, alive, lookup);
		expect(result.ok ? "" : result.error).toBe("stray (stray-1) is gone-1's sub: message gone-1");
	});
});

describe("children: a parent's live subs", () => {
	test("fans out to the live ones only", () => {
		expect(reach("lead-1", "children")).toBe("fixer-1:children,scout-1:children");
		expect(reach("boss-1", "@Children")).toBe("worker-1:children");
	});

	test("a top-level session without live subs is told so", () => {
		expect(reach("loner-1", "children")).toBe("error:you have no live subs (msg_list shows them)");
	});
});

describe("top-level sessions message each other strictly", () => {
	test("by exact id, live name or a folder with one live session", () => {
		expect(reach("loner-1", "boss")).toBe("boss-1:name");
		expect(reach("loner-1", "lead-1")).toBe("lead-1:id");
		expect(reach("loner-1", "/other")).toBe("boss-1:folder");
		expect(reach("boss-1", "loner")).toBe("loner-1:name");
	});

	test("never itself, and says so", () => {
		expect(reach("loner-1", "loner")).toBe('error:"loner" is you');
		expect(reach("loner-1", "loner-1")).toBe('error:"loner-1" is you');
		expect(reach("loner-1", "/solo")).toBe('error:"/solo" is you');
	});

	test("a parent has no parent to reach", () => {
		expect(reach("lead-1", "parent")).toBe("error:you have no parent session (no session's bash started you)");
	});
});

describe("findRecipients reads the store", () => {
	test("same answers as recipients over the store's records", () => {
		for (const record of world) writePresence(root, record);
		const found = findRecipients(root, asker("scout-1"), "parent", NOW, alive, lookup);
		expect(found.ok && found.value.map((target) => target.id)).toEqual(["lead-1"]);
		const refused = findRecipients(root, asker("loner-1"), "worker", NOW, alive, lookup);
		expect(refused.ok ? "" : refused.error).toBe("worker (worker-1) is boss's sub: message boss (boss-1)");
	});
});

describe("post", () => {
	test("drops the message in the recipient's inbox, without delivery or byUser", () => {
		const target: Target = { id: "you-1", presence: presence({ id: "you-1" }), live: true, via: "name" };
		const posted = post(root, { id: "me-1", name: "main" }, target, { text: "hi", awaitingUntil: 99, replyTo: "000000001-abcdef" }, 5);
		expect(posted.ok).toBe(true);
		const [sent] = waiting(root, "you-1");
		expect(sent && [sent.text, sent.awaitingUntil, sent.replyTo, sent.from.name, "delivery" in sent, "byUser" in sent]).toEqual(["hi", 99, "000000001-abcdef", "main", false, false]);
	});

	test("rejects an empty message without touching the inbox", () => {
		const target: Target = { id: "you-1", presence: presence({ id: "you-1" }), live: true, via: "name" };
		expect(post(root, { id: "me-1" }, target, { text: " " }, 5).ok).toBe(false);
		expect(waiting(root, "you-1")).toEqual([]);
	});

	test("a parent without a record still gets the mail", () => {
		const target: Target = { id: "boss-1", live: false, via: "parent" };
		expect(post(root, { id: "me-1" }, target, { text: "question" }, 5).ok).toBe(true);
		expect(waiting(root, "boss-1").map((sent) => sent.text)).toEqual(["question"]);
		expect(canAnswer(target)).toBe(false);
	});
});

describe("postExit", () => {
	test("ended goes from the sub, stopped or not; died names the life", () => {
		const done = postExit(root, { id: "k-1", name: "kid", cwd: "/f/1" }, "boss-1", { kind: "ended", stopped: false }, "all done", 9);
		expect(done.ok && [done.value.kind, done.value.to, done.value.from.id, done.value.text, "stopped" in done.value]).toEqual(["ended", "boss-1", "k-1", "all done", false]);
		const cut = postExit(root, { id: "k-3" }, "boss-1", { kind: "ended", stopped: true }, "half way", 10);
		expect(cut.ok && cut.value.stopped).toBe(true);
		const died = postExit(root, { id: "k-2" }, "boss-1", { kind: "died", life: { pid: 7, startedAt: 3 } }, "gone", 11);
		expect(died.ok && [died.value.kind, died.value.life, "stopped" in died.value]).toEqual(["died", { pid: 7, startedAt: 3 }, false]);
		expect(waiting(root, "boss-1").map((sent) => [sent.kind, sent.stopped ?? false, sent.life?.pid])).toEqual([
			["ended", false, undefined],
			["ended", true, undefined],
			["died", false, 7],
		]);
	});

	test("senderOf: a record as a message sender", () => {
		expect(senderOf(presence({ id: "k-1", name: "kid", cwd: "/f/1" }))).toEqual({ id: "k-1", name: "kid", cwd: "/f/1" });
		expect(senderOf(presence({ id: "k-2", cwd: "/f/2" }))).toEqual({ id: "k-2", cwd: "/f/2" });
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

describe("msg_list views per role", () => {
	const dir = directory(world, NOW, alive);
	const view = (id: string, all = false) => formatDirectory(dir, asker(id) as Presence, NOW, "/home/u", { all, maxOffline: 5 }).split("\n");

	test("a sub sees itself and its parent, and the rule, whatever all says", () => {
		const expected = [
			"you: scout · scout-1 · print · /repo/.forks/1",
			"parent: lead · lead-1 · tui · idle · /repo · up 17m",
			`you're a sub: msg_send reaches only your parent (to: "parent").`,
		];
		expect(view("scout-1")).toEqual(expected);
		expect(view("scout-1", true)).toEqual(expected);
	});

	test("a parent sees itself and its subs", () => {
		expect(view("lead-1")).toEqual([
			"you: lead · lead-1 · tui · /repo",
			'subs: 3 (2 live; to: "children" messages the live ones)',
			"- fixer · fixer-1 · print · busy · /repo/.forks/2 · up 17m",
			"- scout · scout-1 · print · busy · /repo/.forks/1 · up 17m",
			"- old · old-1 · print · ended · /repo/.forks/3 · 60s ago",
			"(3 other live sessions: all: true lists everyone)",
		]);
	});

	test("a top-level session sees everyone live, others' subs marked as theirs", () => {
		expect(view("loner-1")).toEqual([
			"you: loner · loner-1 · tui · /solo",
			"5 live:",
			"- boss · boss-1 · web · idle · /other · up 17m",
			"- fixer · fixer-1 · print · busy · /repo/.forks/2 · up 17m (lead's sub)",
			"- lead · lead-1 · tui · idle · /repo · up 17m",
			"- scout · scout-1 · print · busy · /repo/.forks/1 · up 17m (lead's sub)",
			"- worker · worker-1 · print · busy · /other/.forks/1 · up 17m (boss's sub)",
			"(1 offline not shown)",
		]);
		expect(view("lead-1", true)).toContain("- scout · scout-1 · print · busy · /repo/.forks/1 · up 17m (your sub)");
		expect(view("lead-1", true)).toContain("- old · old-1 · print · ended · /repo/.forks/3 · 60s ago (your sub)");
	});

	test("a parent with no record", () => {
		const orphan = presence({ id: "me", name: "main", parent: "ghost", heartbeatAt: NOW });
		const text = formatDirectory(directory([orphan], NOW, alive), orphan, NOW, "/home/u", { all: false, maxOffline: 5 });
		expect(text).toContain("parent: ghost (never ran msg: no presence record; mail waits in its inbox)");
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

	test("describeOffline says ended or offline, and when", () => {
		const ended = presence({ id: "e-1", name: "kid", mode: "print", cwd: "/home/u/f", heartbeatAt: 0, endedAt: 3 * 60_000 });
		expect(describeOffline(ended, 5 * 60_000, "/home/u")).toBe("kid · e-1 · print · ended · ~/f · 2m ago");
		expect(describeOffline({ ...ended, endedAt: undefined }, 5 * 60_000, "/home/u")).toBe("kid · e-1 · print · offline · ~/f · last seen 5m ago");
	});

	test("expectation and label for a parent that never ran msg", () => {
		const target: Target = { id: "boss-1", live: false, via: "parent" };
		expect(expectation(target, 0)).toContain("never run msg");
		expect(targetLabel(target)).toBe("your parent (boss-1)");
	});

	test("expectation explains when the message lands", () => {
		const now = 1_000_000;
		const of = (overrides: Parameters<typeof presence>[0], live = true): Target => ({ id: overrides.id, presence: presence({ heartbeatAt: now, ...overrides }), live, via: "name" });
		expect(expectation(of({ id: "a", activity: "busy" }), now)).toBe("busy; it sees the message at its next step");
		expect(expectation(of({ id: "a", activity: "idle" }), now)).toBe("idle; it wakes up to handle the message");
		expect(expectation(of({ id: "a", activity: "idle", mode: "print" }), now)).toContain("about to exit");
		expect(expectation(of({ id: "a", heartbeatAt: now - 7_200_000 }, false), now)).toContain("offline (last seen 2h ago)");
	});
});

describe("replyText: what a waiting msg_send returns", () => {
	const kid = { id: "k-1", name: "kid" };

	test("a reply, an end, a stop, a death, a timeout", () => {
		expect(replyText({ kind: "message", message: message({ to: "me", from: kid, text: "42" }) }, "kid", 60)).toMatch(/^kid replied \(\S+\):\n42$/);
		expect(replyText({ kind: "message", message: message({ to: "me", from: kid, kind: "ended", text: "done" }) }, "kid", 60)).toBe("kid ended before replying. Its final message:\ndone");
		expect(replyText({ kind: "message", message: message({ to: "me", from: kid, kind: "ended", stopped: true, text: "halfway" }) }, "kid", 60)).toBe(
			"kid was stopped before it finished, without replying. Its last message, not a finished report (inspect its work before relying on it):\nhalfway",
		);
		expect(replyText({ kind: "message", message: message({ to: "me", from: kid, kind: "died", text: "gone" }) }, "kid", 60)).toBe("kid died before replying: gone");
		expect(replyText({ kind: "timeout" }, "kid", 60)).toContain("No reply from kid within 60s.");
		expect(replyText({ kind: "aborted" }, "kid", 60)).toContain("Stopped waiting for kid.");
	});

	test("headline marks ended, stopped and died", () => {
		expect(headline(message({ to: "me", from: kid }))).toBe("✉ kid");
		expect(headline(message({ to: "me", from: kid, kind: "ended" }))).toBe("✉ kid ended");
		expect(headline(message({ to: "me", from: kid, kind: "ended", stopped: true }))).toBe("✉ kid was stopped before it finished");
		expect(headline(message({ to: "me", from: kid, kind: "died" }))).toBe("✉ kid died");
	});
});
