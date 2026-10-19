import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../src/core/fsx.ts";
import { sessionsDir } from "../src/core/paths.ts";
import { directory, isLive, listPresence, parsePresence, pidAlive, pruneOffline, readPresence, readSessions, STALE_AFTER_MS, writePresence } from "../src/core/registry.ts";
import { LIKELY_LISTED, resolveTarget } from "../src/core/resolve.ts";
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

	test("readSessions lists every record file but reads only the wanted ones", () => {
		writePresence(root, presence({ id: "s-1" }));
		writePresence(root, presence({ id: "s-2" }));
		writeFileSync(join(sessionsDir(root), "broken.json"), "{");
		writeFileSync(join(sessionsDir(root), ".s-3.json.123.abcdef01.tmp"), "{");
		const wanted: string[] = [];
		const look = readSessions(root, (file) => {
			wanted.push(file);
			return file !== "s-1.json";
		});
		expect([...look.files]).toEqual(["broken.json", "s-1.json", "s-2.json"]);
		expect(wanted).toEqual(["broken.json", "s-1.json", "s-2.json"]);
		expect(look.records.map((record) => record.id)).toEqual(["s-2"]);
		expect(readSessions(join(root, "nowhere"), () => true)).toEqual({ files: new Set(), records: [] });
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

describe("resolveTarget: strict", () => {
	const now = 1_000_000;
	const dir = directory(
		[
			presence({ id: "01a13e22-aaaa", name: "main", heartbeatAt: now }),
			presence({ id: "01a13e22-bbbb", name: "builder", heartbeatAt: now }),
			presence({ id: "01a14f00-cccc", name: "builder", heartbeatAt: 10, endedAt: now - 120_000 }),
			presence({ id: "01a15000-dddd", name: "reviewer", heartbeatAt: now - 7_200_000, endedAt: now - 7_200_000 }),
			presence({ id: "01a15000-eeee", name: "reviewer", heartbeatAt: now - 300_000 }),
			presence({ id: "twin-1", name: "twin", heartbeatAt: now }),
			presence({ id: "twin-2", name: "Twin", heartbeatAt: now }),
		],
		now,
		alive,
	);

	const resolved = (query: string) => {
		const result = resolveTarget(query, dir, { id: "asker" }, { home: "/home/u" }, now);
		return result.ok ? `${result.value.id}:${result.value.live ? "live" : "offline"}:${result.value.via}` : `error:${result.error}`;
	};

	test("an exact id, live or offline", () => {
		expect(resolved("01a14f00-cccc")).toBe("01a14f00-cccc:offline:id");
		expect(resolved("01a13e22-aaaa")).toBe("01a13e22-aaaa:live:id");
	});

	test("a live name, case-insensitively, with @ allowed; it beats an offline namesake", () => {
		expect(resolved("builder")).toBe("01a13e22-bbbb:live:name");
		expect(resolved("@Builder")).toBe("01a13e22-bbbb:live:name");
	});

	test("two live with the name is an error that lists both exact ids", () => {
		expect(resolved("twin")).toBe('error:name "twin" is ambiguous: twin (twin-1), Twin (twin-2). Use the exact session id.');
	});

	test("no id prefix match: a prefix names the likely sessions, live and offline, with exact ids", () => {
		expect(resolved("01a14f")).toBe(
			'error:"01a14f" is no live session\'s name and no session\'s exact id. Likely: builder (01a14f00-cccc), ended 2m ago. To message one of them, use its exact id.',
		);
		expect(resolved("01a13e22")).toContain("Likely: builder (01a13e22-bbbb), live now; main (01a13e22-aaaa), live now.");
		expect(resolved("01a")).toBe(
			'error:no session matches "01a" (live sessions: builder (01a13e22-bbbb), main (01a13e22-aaaa), twin (twin-1), Twin (twin-2))',
		);
	});

	test("no offline-name fallback: the error names each offline namesake with its exact id and when it was last seen", () => {
		expect(resolved("reviewer")).toBe(
			'error:"reviewer" is no live session\'s name and no session\'s exact id. Likely: reviewer (01a15000-eeee), last seen 5m ago; reviewer (01a15000-dddd), ended 2h ago. To message one of them, use its exact id.',
		);
	});

	test("unknown names say who is live; an empty recipient is an error", () => {
		const message = resolved("ghost");
		expect(message).toContain('no session matches "ghost"');
		expect(message).toContain("main (01a13e22-aaaa)");
		expect(resolved("  ")).toBe("error:recipient is empty");
	});

	test("the likely list stops at LIKELY_LISTED", () => {
		const many = directory(
			Array.from({ length: LIKELY_LISTED + 2 }, (_, index) => presence({ id: `old-${index}`, name: "gone", heartbeatAt: now - index * 60_000, endedAt: now - index * 60_000 })),
			now,
			alive,
		);
		const result = resolveTarget("gone", many, { id: "asker" }, { home: "/home/u" }, now);
		expect(result.ok ? "" : result.error.split("; ").length).toBe(LIKELY_LISTED);
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
		presence({ id: "kid-2", name: "kid", parent: "me", cwd: "/repo/.forks/2", heartbeatAt: 10, endedAt: now - 60_000 }),
		presence({ id: "far-1", name: "builder", cwd: "/elsewhere", heartbeatAt: now }),
		presence({ id: "far-2", name: "lonely", cwd: "/elsewhere", heartbeatAt: now }),
		presence({ id: "twin-a", name: "twin", parent: "me", cwd: "/twins", heartbeatAt: now }),
		presence({ id: "twin-b", name: "twin", parent: "me", cwd: "/twins", heartbeatAt: now }),
		presence({ id: "old-1", name: "gone", cwd: "/old", heartbeatAt: now - 7_200_000, endedAt: now - 7_200_000 }),
		presence({ id: "old-2", name: "gone", cwd: "/old", heartbeatAt: now - 180_000 }),
	];
	const dir = directory(records, now, alive);
	const me = { id: "me", parent: "boss-1", cwd: "/repo/.forks" };
	const resolved = (query: string, asker: Parameters<typeof resolveTarget>[2] = me, canonical?: (path: string) => string) => {
		const result = resolveTarget(query, dir, asker, { home: "/home/u", ...(canonical ? { canonical } : {}) }, now);
		return result.ok ? `${result.value.id}:${result.value.live ? "live" : "offline"}:${result.value.via}` : `error:${result.error}`;
	};

	test("parent resolves to your parent, recorded or not", () => {
		expect(resolved("parent")).toBe("boss-1:live:parent");
		expect(resolved("@Parent")).toBe("boss-1:live:parent");
		expect(resolved("parent", { id: "me", parent: "nobody-1" })).toBe("nobody-1:offline:parent");
		expect(resolved("nobody-1", { id: "me", parent: "nobody-1" })).toBe("nobody-1:offline:parent");
		expect(resolved("parent", { id: "me" })).toContain("error:you have no parent session");
	});

	test("an exact id resolves; children is a group, not a session", () => {
		expect(resolved("kid-1")).toBe("kid-1:live:id");
		expect(resolved("children")).toBe('error:"children" names a group, not one session');
	});

	test("a folder finds the one live session working there", () => {
		expect(resolved("/repo/.forks/1")).toBe("kid-1:live:folder");
		expect(resolved("/repo/.forks/1/")).toBe("kid-1:live:folder");
		expect(resolved("./1")).toBe("kid-1:live:folder");
		expect(resolved("../../repo/.forks/1", { id: "me", cwd: "/elsewhere/x" })).toBe("kid-1:live:folder");
		expect(resolved("..")).toBe("boss-1:live:folder");
	});

	test("~ is home; symlinked spellings meet through canonical", () => {
		const homeDir = directory([presence({ id: "h-1", cwd: "/home/u/proj", heartbeatAt: now })], now, alive);
		const result = resolveTarget("~/proj", homeDir, me, { home: "/home/u" }, now);
		expect(result.ok && result.value.id).toBe("h-1");
		const canonical = (path: string) => path.replace(/^\/tmp\b/, "/private/tmp");
		const tmpDir = directory([presence({ id: "t-1", cwd: "/private/tmp/w", heartbeatAt: now })], now, alive);
		const viaLink = resolveTarget("/tmp/w", tmpDir, me, { home: "/home/u", canonical }, now);
		expect(viaLink.ok && viaLink.value.id).toBe("t-1");
	});

	test("several live sessions in one folder is an error that lists them", () => {
		expect(resolved("/twins")).toBe("error:2 live sessions work in /twins: twin (twin-a), twin (twin-b). Use the exact session id.");
		expect(resolved("/elsewhere")).toContain("error:2 live sessions work in /elsewhere");
	});

	test("no last-seen fallback: a folder with nobody live names who was last there, with exact ids and when", () => {
		expect(resolved("/old")).toBe(
			"error:nobody live works in /old. Last there: gone (old-2), last seen 3m ago; gone (old-1), ended 2h ago. To message one of them anyway, use its exact id.",
		);
		expect(resolved("/repo/.forks/2")).toBe(
			"error:nobody live works in /repo/.forks/2. Last there: kid (kid-2), ended 60s ago. To message one of them anyway, use its exact id.",
		);
		expect(resolved("/nowhere")).toBe("error:no session works in /nowhere");
	});

	test("a live name prefers your family, then anyone", () => {
		expect(resolved("builder")).toBe("kid-1:live:name");
		expect(resolved("builder", { id: "stranger" })).toContain('error:name "builder" is ambiguous');
		expect(resolved("lonely")).toBe("far-2:live:name");
		expect(resolved("boss")).toBe("boss-1:live:name");
		expect(resolved("twin")).toContain('error:name "twin" is ambiguous');
	});

	test("an offline name or an id prefix never resolves", () => {
		expect(resolved("gone")).toContain("error:\"gone\" is no live session's name");
		expect(resolved("kid")).toBe(
			"error:\"kid\" is no live session's name and no session's exact id. Likely: kid (kid-2), ended 60s ago. To message one of them, use its exact id.",
		);
		expect(resolved("boss-")).toContain("Likely: boss (boss-1), live now.");
	});
});
