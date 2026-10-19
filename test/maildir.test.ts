import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claim, deliver, ensureMailbox, messagesSince, pending, pruneDelivered, unclaim } from "../src/core/maildir.ts";
import { message, tempRoot } from "./helpers.ts";

let root = "";
let cleanup = () => {};

beforeEach(() => {
	({ root, cleanup } = tempRoot());
});

afterEach(() => cleanup());

describe("deliver", () => {
	test("lands in new/ with nothing left in tmp/", () => {
		const sent = message({ to: "bob" });
		deliver(root, sent);
		const dirs = ensureMailbox(root, "bob");
		expect(pending(root, "bob")).toEqual([`${sent.id}.json`]);
		expect(readdirSync(dirs.tmp)).toEqual([]);
		expect(readdirSync(dirs.cur)).toEqual([]);
	});

	test("pending is oldest first", () => {
		const later = message({ to: "bob", text: "2" }, 2_000);
		const earlier = message({ to: "bob", text: "1" }, 1_000);
		deliver(root, later);
		deliver(root, earlier);
		expect(pending(root, "bob")).toEqual([`${earlier.id}.json`, `${later.id}.json`]);
	});

	test("an unknown mailbox has nothing pending", () => {
		expect(pending(root, "nobody")).toEqual([]);
	});
});

describe("claim", () => {
	test("moves the message to cur/ and returns it, once", () => {
		const sent = message({ to: "bob", text: "ping" });
		deliver(root, sent);
		const file = `${sent.id}.json`;
		expect(claim(root, "bob", file)).toEqual({ kind: "message", file, message: sent });
		expect(claim(root, "bob", file)).toBeUndefined();
		expect(pending(root, "bob")).toEqual([]);
	});

	test("unclaim hands it back", () => {
		const sent = message({ to: "bob" });
		deliver(root, sent);
		const file = `${sent.id}.json`;
		claim(root, "bob", file);
		expect(unclaim(root, "bob", file)).toBe(true);
		expect(pending(root, "bob")).toEqual([file]);
		expect(unclaim(root, "bob", "missing.json")).toBe(false);
	});

	test("a garbage file is claimed as invalid instead of blocking the queue", () => {
		const dirs = ensureMailbox(root, "bob");
		writeFileSync(join(dirs.new, "000000000-zzzzzz.json"), "{not json");
		expect(claim(root, "bob", "000000000-zzzzzz.json")).toEqual({ kind: "invalid", file: "000000000-zzzzzz.json", error: "not valid JSON" });
		expect(pending(root, "bob")).toEqual([]);
	});

	test("concurrent claimers in separate processes take each message exactly once", async () => {
		const total = 120;
		const sent = Array.from({ length: total }, (_, index) => message({ to: "bob", text: `m${index}` }, 1_000 + index));
		for (const item of sent) deliver(root, item);
		const worker = join(import.meta.dir, "claim-worker.ts");
		const runs = Array.from({ length: 4 }, () =>
			Bun.spawn(["bun", worker, root, "bob"], { stdout: "pipe", stderr: "inherit" }),
		);
		const outputs = await Promise.all(runs.map((run) => new Response(run.stdout).text()));
		await Promise.all(runs.map((run) => run.exited));
		const claimed = outputs.flatMap((output) => output.split("\n").filter(Boolean));
		expect(claimed.length).toBe(total);
		expect(new Set(claimed).size).toBe(total);
		expect(pending(root, "bob")).toEqual([]);
	});
});

describe("messagesSince", () => {
	test("pending and delivered messages sent at or after a time; older files aren't read", () => {
		const old = message({ to: "bob", text: "old" }, 1_000);
		const edge = message({ to: "bob", text: "edge" }, 2_000);
		const late = message({ to: "bob", text: "late" }, 3_000);
		[old, edge, late].forEach((item) => deliver(root, item));
		claim(root, "bob", `${late.id}.json`);
		const dirs = ensureMailbox(root, "bob");
		writeFileSync(join(dirs.new, `${message({ to: "bob" }, 500).id}.json`), "{not json");
		expect(messagesSince(root, "bob", 2_000).map((item) => item.text)).toEqual(["edge", "late"]);
		expect(messagesSince(root, "bob", 3_001)).toEqual([]);
		expect(messagesSince(root, "nobody", 0)).toEqual([]);
	});

	test("a file whose name isn't a message id is read to be safe", () => {
		const dirs = ensureMailbox(root, "bob");
		writeFileSync(join(dirs.cur, "hand-written.json"), JSON.stringify(message({ to: "bob", text: "odd" }, 1)));
		expect(messagesSince(root, "bob", 5_000).map((item) => item.text)).toEqual(["odd"]);
	});
});

describe("pruneDelivered", () => {
	test("deletes only delivered messages past the age limit", () => {
		const old = message({ to: "bob", text: "old" }, 1_000);
		const fresh = message({ to: "bob", text: "fresh" }, 2_000);
		const waiting = message({ to: "bob", text: "waiting" }, 3_000);
		[old, fresh, waiting].forEach((item) => deliver(root, item));
		claim(root, "bob", `${old.id}.json`);
		claim(root, "bob", `${fresh.id}.json`);
		const dirs = ensureMailbox(root, "bob");
		const now = Date.now();
		utimesSync(join(dirs.cur, `${old.id}.json`), new Date(now - 10_000), new Date(now - 10_000));
		utimesSync(join(dirs.new, `${waiting.id}.json`), new Date(now - 10_000), new Date(now - 10_000));
		expect(pruneDelivered(root, "bob", now, 5_000)).toBe(1);
		expect(readdirSync(dirs.cur)).toEqual([`${fresh.id}.json`]);
		expect(pending(root, "bob")).toEqual([`${waiting.id}.json`]);
	});
});
