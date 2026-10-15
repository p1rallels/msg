import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, sweepTmp, tmpWriterPid, writeFileAtomic } from "../src/core/fsx.ts";
import { sweepOrphans, TMP_MAX_AGE_MS } from "../src/core/housekeeping.ts";
import { ensureMailbox } from "../src/core/maildir.ts";
import { sessionsDir } from "../src/core/paths.ts";
import { tempRoot } from "./helpers.ts";

let root = "";
let cleanup = () => {};

beforeEach(() => {
	({ root, cleanup } = tempRoot());
});

afterEach(() => cleanup());

describe("writeFileAtomic", () => {
	test("writes private files and leaves no temp file behind", () => {
		const target = join(root, "a", "b.json");
		writeFileAtomic(target, "one");
		writeFileAtomic(target, "two", { durable: true });
		expect(readFileSync(target, "utf8")).toBe("two");
		expect(statSync(target).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(root, "a"))).toEqual(["b.json"]);
	});

	test("temp files go to tmpDir when given", () => {
		const tmpDir = ensureDir(join(root, "tmp"));
		writeFileAtomic(join(root, "out", "x.json"), "{}", { tmpDir });
		expect(readdirSync(tmpDir)).toEqual([]);
	});
});

describe("orphaned temp files", () => {
	const orphan = (dir: string, pid: number, ageMs = 0): string => {
		const name = `.x.json.${pid}.0a1b2c3d.tmp`;
		const path = join(ensureDir(dir), name);
		writeFileSync(path, "partial");
		const then = new Date(Date.now() - ageMs);
		utimesSync(path, then, then);
		return name;
	};

	test("tmpWriterPid reads the writer's pid from the name", () => {
		expect(tmpWriterPid(".x.json.4242.0a1b2c3d.tmp")).toBe(4242);
		expect(tmpWriterPid("x.json")).toBeUndefined();
		expect(tmpWriterPid(".x.json.tmp")).toBeUndefined();
	});

	test("sweeps dead writers and stale files, keeps live writers and other files", () => {
		const dir = join(root, "t");
		const dead = orphan(dir, 111);
		const live = orphan(dir, 222);
		const stale = orphan(dir, 333, 2 * 60 * 60_000);
		writeFileSync(join(dir, "keep.json"), "{}");
		const swept = sweepTmp(dir, Date.now(), (pid) => pid !== 111, 60 * 60_000);
		expect(swept).toBe(2);
		expect(readdirSync(dir).sort()).toEqual([live, "keep.json"].sort());
		expect(readdirSync(dir)).not.toContain(dead);
		expect(readdirSync(dir)).not.toContain(stale);
		expect(sweepTmp(join(root, "missing"), Date.now(), () => true, 1)).toBe(0);
	});

	test("sweepOrphans covers the registry and every inbox", () => {
		orphan(sessionsDir(root), 111);
		orphan(ensureMailbox(root, "bob").tmp, 111);
		orphan(ensureMailbox(root, "eve").tmp, 222, TMP_MAX_AGE_MS + 60_000);
		orphan(ensureMailbox(root, "amy").tmp, 222);
		expect(sweepOrphans(root, Date.now(), (pid) => pid === 222)).toBe(3);
		expect(readdirSync(ensureMailbox(root, "amy").tmp).length).toBe(1);
	});
});
