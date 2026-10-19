import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../src/core/fsx.ts";
import { sessionsDir } from "../src/core/paths.ts";
import { directory, isLive, listPresence, parsePresence, pidAlive, pruneOffline, readPresence, STALE_AFTER_MS, writePresence } from "../src/core/registry.ts";
import { resolveTarget } from "../src/core/resolve.ts";
import { presence, tempRoot } from "./helpers.ts";

let root = "";
let cleanup = () => {};

beforeEach(() => {
	({ root, cleanup } = tempRoot());
});

afterEach(() => cleanup());

const alive = () => true;
const dead = () => false;

describe("presence records", () => {
	test("write, read and list", () => {
		const record = presence({ id: "s-1", name: "builder" });
		writePresence(root, record);
		expect(readPresence(root, "s-1")).toEqual(record);
		expect(readPresence(root, "nope")).toBeUndefined();
		expect(readPresence(root, "../x")).toBeUndefined();
		expect(listPresence(root)).toEqual([record]);
	});

	test("list skips junk files", () => {
		writePresence(root, presence({ id: "s-1" }));
		ensureDir(sessionsDir(root));
		writeFileSync(join(sessionsDir(root), "broken.json"), "{");
		writeFileSync(join(sessionsDir(root), "wrong.json"), JSON.stringify({ v: 9 }));
		expect(listPresence(root).map((record) => record.id)).toEqual(["s-1"]);
	});

	test("parse fills safe defaults for unknown mode and activity", () => {
		const parsed = parsePresence({ ...presence({ id: "s-1" }), mode: "hologram", activity: "dancing" });
		expect(parsed.ok && [parsed.value.mode, parsed.value.activity]).toEqual(["rpc", "idle"]);
		expect(parsePresence({ ...presence({ id: "s-1" }), pid: "1" }).ok).toBe(false);
	});
});

describe("liveness", () => {
	const record = presence({ id: "s-1", heartbeatAt: 100_000 });

	test("needs a fresh heartbeat, a running pid and no end mark", () => {
		expect(isLive(record, 100_000 + STALE_AFTER_MS, alive)).toBe(true);
		expect(isLive(record, 100_001 + STALE_AFTER_MS, alive)).toBe(false);
		expect(isLive(record, 100_000, dead)).toBe(false);
		expect(isLive({ ...record, endedAt: 100_000 }, 100_000, alive)).toBe(false);
	});

	test("pidAlive sees this process and not a bogus pid", () => {
		expect(pidAlive(process.pid)).toBe(true);
		expect(pidAlive(0)).toBe(false);
		expect(pidAlive(-5)).toBe(false);
		expect(pidAlive(2 ** 22 + 12_345)).toBe(false);
	});

	test("directory: live by name, offline most recently seen first", () => {
		const now = 1_000_000;
		const records = [
			presence({ id: "c", name: "zeta", heartbeatAt: now }),
			presence({ id: "a", name: "alpha", heartbeatAt: now }),
			presence({ id: "b", heartbeatAt: now }),
			presence({ id: "old", name: "old", heartbeatAt: 10 }),
			presence({ id: "older", name: "older", heartbeatAt: 5 }),
			presence({ id: "ended", name: "ended", heartbeatAt: now, endedAt: 20 }),
		];
		const dir = directory(records, now, alive);
		expect(dir.live.map((r) => r.id)).toEqual(["a", "c", "b"]);
		expect(dir.offline.map((r) => r.id)).toEqual(["ended", "old", "older"]);
	});

	test("pruneOffline forgets long-gone records only", () => {
		const now = 1_000_000;
		writePresence(root, presence({ id: "fresh", heartbeatAt: now }));
		writePresence(root, presence({ id: "gone", heartbeatAt: 10 }));
		writePresence(root, presence({ id: "recent", heartbeatAt: now - 1_000, endedAt: now - 1_000 }));
		expect(pruneOffline(root, now, 10_000, alive)).toBe(1);
		expect(listPresence(root).map((r) => r.id).sort()).toEqual(["fresh", "recent"]);
	});
});

describe("resolveTarget", () => {
	const now = 1_000_000;
	const dir = directory(
		[
			presence({ id: "01a13e22-aaaa", name: "main", heartbeatAt: now }),
			presence({ id: "01a13e22-bbbb", name: "builder", heartbeatAt: now }),
			presence({ id: "01a14f00-cccc", name: "builder", heartbeatAt: 10, endedAt: 10 }),
			presence({ id: "01a15000-dddd", name: "reviewer", heartbeatAt: 50, endedAt: 50 }),
			presence({ id: "01a15000-eeee", name: "reviewer", heartbeatAt: 70, endedAt: 70 }),
			presence({ id: "twin-1", name: "twin", heartbeatAt: now }),
			presence({ id: "twin-2", name: "Twin", heartbeatAt: now }),
		],
		now,
		alive,
	);

	const resolved = (query: string) => {
		const result = resolveTarget(query, dir, { id: "asker" }, { home: "/home/u" });
		return result.ok ? `${result.value.id}:${result.value.live ? "live" : "offline"}:${result.value.via}` : `error:${result.error}`;
	};

	test("exact id first", () => {
		expect(resolved("01a14f00-cccc")).toBe("01a14f00-cccc:offline:id");
	});

	test("a live name beats an offline one, case-insensitively, with @ allowed", () => {
		expect(resolved("builder")).toBe("01a13e22-bbbb:live:name");
		expect(resolved("@Builder")).toBe("01a13e22-bbbb:live:name");
	});

	test("ambiguous live names are an error that lists the candidates", () => {
		expect(resolved("twin")).toContain('error:name "twin" is ambiguous');
		expect(resolved("twin")).toContain("twin-1");
	});

	test("unique id prefix of at least 4 chars", () => {
		expect(resolved("01a14f")).toBe("01a14f00-cccc:offline:prefix");
		expect(resolved("01a13e22")).toContain('error:id prefix "01a13e22" is ambiguous');
		expect(resolved("01a")).toContain("error:no session matches");
	});

	test("offline name picks the most recently seen", () => {
		expect(resolved("reviewer")).toBe("01a15000-eeee:offline:name");
	});

	test("unknown names say who is live", () => {
		const message = resolved("ghost");
		expect(message).toContain('no session matches "ghost"');
		expect(message).toContain("main (01a13e22-aaaa)");
		expect(resolved("  ")).toBe("error:recipient is empty");
	});
});

describe("presence parent", () => {
	test("kept when it's a valid id other than the session's own", () => {
		const parsed = (parent: unknown) => {
			const result = parsePresence({ ...presence({ id: "s-1" }), parent });
			return result.ok ? result.value.parent : "invalid";
		};
		expect(parsed("p-1")).toBe("p-1");
		expect(parsed("s-1")).toBeUndefined();
		expect(parsed("../x")).toBeUndefined();
		expect(parsed(42)).toBeUndefined();
		expect(parsed(undefined)).toBeUndefined();
	});
});

describe("resolveTarget: parent, folders, family first", () => {
	const now = 1_000_000;
	const records = [
		presence({ id: "boss-1", name: "boss", cwd: "/repo", heartbeatAt: now }),
		presence({ id: "kid-1", name: "builder", parent: "me", cwd: "/repo/.forks/1", heartbeatAt: now }),
		presence({ id: "kid-2", name: "kid", parent: "me", cwd: "/repo/.forks/2", heartbeatAt: 10, endedAt: 10 }),
		presence({ id: "far-1", name: "builder", cwd: "/elsewhere", heartbeatAt: now }),
		presence({ id: "far-2", name: "lonely", cwd: "/elsewhere", heartbeatAt: now }),
		presence({ id: "twin-a", name: "twin", parent: "me", cwd: "/twins", heartbeatAt: now }),
		presence({ id: "twin-b", name: "twin", parent: "me", cwd: "/twins", heartbeatAt: now }),
		presence({ id: "old-1", name: "gone", cwd: "/old", heartbeatAt: 50, endedAt: 50 }),
		presence({ id: "old-2", name: "gone", cwd: "/old", heartbeatAt: 70, endedAt: 70 }),
	];
	const dir = directory(records, now, alive);
	const me = { id: "me", parent: "boss-1", cwd: "/repo/.forks" };
	const resolved = (query: string, asker: Parameters<typeof resolveTarget>[2] = me, canonical?: (path: string) => string) => {
		const result = resolveTarget(query, dir, asker, { home: "/home/u", ...(canonical ? { canonical } : {}) });
		return result.ok ? `${result.value.id}:${result.value.live ? "live" : "offline"}:${result.value.via}` : `error:${result.error}`;
	};

	test("parent resolves to your parent, recorded or not", () => {
		expect(resolved("parent")).toBe("boss-1:live:parent");
		expect(resolved("@Parent")).toBe("boss-1:live:parent");
		expect(resolved("parent", { id: "me", parent: "nobody-1" })).toBe("nobody-1:offline:parent");
		expect(resolved("nobody-1", { id: "me", parent: "nobody-1" })).toBe("nobody-1:offline:parent");
		expect(resolved("parent", { id: "me" })).toContain("error:you have no parent session");
	});

	test("exact id beats the parent keyword's neighbours; children is a group, not a session", () => {
		expect(resolved("kid-1")).toBe("kid-1:live:id");
		expect(resolved("children")).toContain('error:"children" names a group');
	});

	test("a folder finds the live session working there", () => {
		expect(resolved("/repo/.forks/1")).toBe("kid-1:live:folder");
		expect(resolved("/repo/.forks/1/")).toBe("kid-1:live:folder");
		expect(resolved("./1")).toBe("kid-1:live:folder");
		expect(resolved("../../repo/.forks/1", { id: "me", cwd: "/elsewhere/x" })).toBe("kid-1:live:folder");
		expect(resolved("..")).toBe("boss-1:live:folder");
	});

	test("~ is home; symlinked spellings meet through canonical", () => {
		const homeDir = directory([presence({ id: "h-1", cwd: "/home/u/proj", heartbeatAt: now })], now, alive);
		const result = resolveTarget("~/proj", homeDir, me, { home: "/home/u" });
		expect(result.ok && result.value.id).toBe("h-1");
		const canonical = (path: string) => path.replace(/^\/tmp\b/, "/private/tmp");
		const tmpDir = directory([presence({ id: "t-1", cwd: "/private/tmp/w", heartbeatAt: now })], now, alive);
		const viaLink = resolveTarget("/tmp/w", tmpDir, me, { home: "/home/u", canonical });
		expect(viaLink.ok && viaLink.value.id).toBe("t-1");
	});

	test("several live sessions in one folder is ambiguous and lists them", () => {
		expect(resolved("/twins")).toContain("error:2 live sessions work in /twins");
		expect(resolved("/twins")).toContain("twin-a");
		expect(resolved("/elsewhere")).toContain("error:2 live sessions work in /elsewhere");
	});

	test("a folder with nobody live falls back to the last session seen there, else fails", () => {
		expect(resolved("/old")).toBe("old-2:offline:folder");
		expect(resolved("/repo/.forks/2")).toBe("kid-2:offline:folder");
		expect(resolved("/nowhere")).toBe("error:no session works in /nowhere");
	});

	test("a live name prefers your family, then anyone", () => {
		expect(resolved("builder")).toBe("kid-1:live:name");
		expect(resolved("builder", { id: "stranger" })).toContain('error:name "builder" is ambiguous');
		expect(resolved("lonely")).toBe("far-2:live:name");
		expect(resolved("boss")).toBe("boss-1:live:name");
		expect(resolved("twin")).toContain('error:name "twin" is ambiguous');
	});

	test("prefix, then the most recently seen offline name", () => {
		expect(resolved("far-")).toContain('error:id prefix "far-" is ambiguous');
		expect(resolved("boss-")).toBe("boss-1:live:prefix");
		expect(resolved("gone")).toBe("old-2:offline:name");
	});
});
