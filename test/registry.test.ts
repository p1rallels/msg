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
		const result = resolveTarget(query, dir);
		return result.ok ? `${result.value.presence.id}:${result.value.live ? "live" : "offline"}:${result.value.via}` : `error:${result.error}`;
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
