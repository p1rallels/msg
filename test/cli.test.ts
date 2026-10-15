import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EXIT, type Io, run } from "../src/cli.ts";
import { claim, deliver, peek, pending } from "../src/core/maildir.ts";
import { createMessage, type Message } from "../src/core/message.ts";
import { readPresence, writePresence } from "../src/core/registry.ts";
import { unwrap } from "../src/core/result.ts";
import { presence, tempRoot } from "./helpers.ts";

let root = "";
let cleanup = () => {};

beforeEach(() => {
	({ root, cleanup } = tempRoot());
});

afterEach(() => cleanup());

const START = 1_800_000_000_000;

interface Harness {
	readonly io: Io;
	readonly out: string[];
	readonly err: string[];
	readonly clock: { now: number };
}

const harness = (env: Record<string, string> = {}, hooks: { onSleep?: (clock: { now: number }) => void; stdin?: string } = {}): Harness => {
	const clock = { now: START };
	const out: string[] = [];
	const err: string[] = [];
	const io: Io = {
		env: { PI_MSG_DIR: root, USER: "tester", ...env },
		cwd: "/work",
		pid: process.pid,
		now: () => clock.now,
		sleep: async (ms) => {
			clock.now += ms;
			hooks.onSleep?.(clock);
		},
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		stdin: () => hooks.stdin ?? "",
	};
	return { io, out, err, clock };
};

const peer = (id: string, name: string, overrides: Partial<Parameters<typeof presence>[0]> = {}) =>
	writePresence(root, presence({ id, name, pid: process.pid, heartbeatAt: START, startedAt: START - 60_000, ...overrides }));

const reply = (from: string, to: string, text: string, replyTo?: string): Message =>
	unwrap(createMessage({ from: { id: from, name: from }, to, text, ...(replyTo ? { replyTo } : {}) }, START + 1));

describe("usage", () => {
	test("no command prints usage and exits 2; --help exits 0", async () => {
		const bare = harness();
		expect(await run([], bare.io)).toBe(EXIT.usage);
		expect(bare.out.join("\n")).toContain("usage:");
		expect(await run(["--help"], harness().io)).toBe(EXIT.ok);
	});

	test("unknown commands and flags are usage errors", async () => {
		const h = harness();
		expect(await run(["frobnicate"], h.io)).toBe(EXIT.usage);
		expect(h.err.join("\n")).toContain('unknown command "frobnicate"');
		expect(await run(["ls", "--bogus"], harness().io)).toBe(EXIT.usage);
		expect(await run(["send", "bob"], harness().io)).toBe(EXIT.usage);
		expect(await run(["wait", "--timeout", "soon"], harness().io)).toBe(EXIT.usage);
	});
});

describe("identity", () => {
	test("inside pi the session id is the identity; --as names it and sticks", async () => {
		const h = harness({ PI_SESSION_ID: "01a1-session" });
		expect(await run(["whoami", "--as", "main"], h.io)).toBe(EXIT.ok);
		expect(h.out[0]).toBe("main · 01a1-session");
		const again = harness({ PI_SESSION_ID: "01a1-session" });
		await run(["whoami"], again.io);
		expect(again.out[0]).toBe("main · 01a1-session");
		expect(readPresence(root, "01a1-session")?.mode).toBe("cli");
	});

	test("outside pi it is cli-$USER; MSG_ID wins over both", async () => {
		const plain = harness();
		await run(["whoami"], plain.io);
		expect(plain.out[0]).toContain("cli-tester");
		const pinned = harness({ MSG_ID: "ops", PI_SESSION_ID: "ignored" });
		await run(["whoami"], pinned.io);
		expect(pinned.out[0]).toContain("ops");
	});

	test("never overwrites the record of a live pi session that owns the id", async () => {
		peer("01a1-session", "main", { mode: "web" });
		const h = harness({ PI_SESSION_ID: "01a1-session" });
		await run(["whoami", "--as", "impostor"], h.io);
		expect(h.out[0]).toBe("main · 01a1-session · live web session");
		expect(readPresence(root, "01a1-session")?.mode).toBe("web");
	});
});

describe("ls", () => {
	test("lists live peers and hides offline ones unless --all", async () => {
		peer("b-1", "builder", { mode: "print", activity: "busy" });
		peer("o-1", "old", { heartbeatAt: START - 3_600_000 });
		const h = harness();
		expect(await run(["ls"], h.io)).toBe(EXIT.ok);
		const text = h.out.join("\n");
		expect(text).toContain("you: (unnamed) · cli-tester · cli");
		expect(text).toContain("builder · b-1 · print · busy");
		expect(text).toContain("(1 offline not shown)");
		const all = harness();
		await run(["ls", "--all"], all.io);
		expect(all.out.join("\n")).toContain("old · o-1");
	});
});

describe("send", () => {
	test("delivers to a peer by name and says what to expect", async () => {
		peer("b-1", "builder", { activity: "busy" });
		const h = harness({}, {});
		expect(await run(["send", "builder", "tests", "are", "red", "--as", "main"], h.io)).toBe(EXIT.ok);
		expect(h.out[0]).toMatch(/^sent \S+ to builder \(b-1\): busy; it sees the message at its next step$/);
		const [entry] = peek(root, "b-1");
		expect(entry?.kind === "message" && [entry.message.text, entry.message.from.name, entry.message.delivery]).toEqual(["tests are red", "main", "steer"]);
	});

	test("- reads the text from stdin; --follow-up and --reply-to are kept", async () => {
		peer("b-1", "builder");
		const h = harness({}, { stdin: "line one\nline two\n" });
		expect(await run(["send", "b-1", "-", "--follow-up", "--reply-to", "000000001-abcdef"], h.io)).toBe(EXIT.ok);
		const [entry] = peek(root, "b-1");
		expect(entry?.kind === "message" && [entry.message.text, entry.message.delivery, entry.message.replyTo]).toEqual(["line one\nline two\n", "followUp", "000000001-abcdef"]);
	});

	test("unknown recipient fails with exit 1", async () => {
		const h = harness();
		expect(await run(["send", "ghost", "hi"], h.io)).toBe(EXIT.error);
		expect(h.err[0]).toContain('no session matches "ghost"');
	});

	test("--wait returns the reply and leaves unrelated mail for inbox", async () => {
		peer("b-1", "builder");
		let replied = false;
		const h = harness(
			{},
			{
				onSleep: () => {
					if (replied) return;
					replied = true;
					const [entry] = peek(root, "b-1");
					if (entry?.kind !== "message") throw new Error("nothing sent");
					deliver(root, reply("c-1", "cli-tester", "unrelated"));
					deliver(root, reply("b-1", "cli-tester", "the answer is 4", entry.message.id));
				},
			},
		);
		expect(await run(["send", "builder", "what is 2+2?", "--wait", "30"], h.io)).toBe(EXIT.ok);
		const text = h.out.join("\n");
		expect(text).toContain("the answer is 4");
		expect(text).not.toContain("unrelated");
		const [entry] = peek(root, "b-1");
		expect(entry?.kind === "message" && entry.message.awaitingUntil).toBe(START + 30_000);
		expect(pending(root, "cli-tester").length).toBe(1);
	});

	test("--wait times out with exit 124 and heartbeats meanwhile", async () => {
		peer("b-1", "builder");
		const h = harness();
		expect(await run(["send", "builder", "anyone?", "--wait", "12"], h.io)).toBe(EXIT.timeout);
		expect(h.out.join("\n")).toContain("no reply within 12s");
		expect(readPresence(root, "cli-tester")?.heartbeatAt).toBeGreaterThanOrEqual(START + 10_000);
	});

	test("won't wait on an idle pi -p run that is about to exit", async () => {
		peer("p-1", "sub", { mode: "print", activity: "idle" });
		const h = harness();
		expect(await run(["send", "sub", "hello?", "--wait", "60"], h.io)).toBe(EXIT.ok);
		expect(h.out.join("\n")).toContain("not waiting");
	});
});

describe("inbox and wait", () => {
	test("inbox takes messages; --peek leaves them", async () => {
		deliver(root, reply("b-1", "cli-tester", "first"));
		const peeked = harness();
		await run(["inbox", "--peek"], peeked.io);
		expect(peeked.out.join("\n")).toContain("first");
		expect(pending(root, "cli-tester").length).toBe(1);
		const taken = harness();
		await run(["inbox"], taken.io);
		expect(taken.out.join("\n")).toContain("── b-1 (b-1)");
		expect(pending(root, "cli-tester").length).toBe(0);
		const empty = harness();
		await run(["inbox"], empty.io);
		expect(empty.out).toEqual(["no new messages"]);
	});

	test("wait --from ignores other senders", async () => {
		peer("b-1", "builder");
		peer("c-1", "critic");
		deliver(root, reply("c-1", "cli-tester", "from critic"));
		const h = harness({}, { onSleep: () => void deliver(root, reply("b-1", "cli-tester", "from builder")) });
		expect(await run(["wait", "--from", "builder", "--timeout", "5"], h.io)).toBe(EXIT.ok);
		expect(h.out.join("\n")).toContain("from builder");
		expect(h.out.join("\n")).not.toContain("from critic");
		expect(pending(root, "cli-tester").length).toBe(1);
	});

	test("wait times out with exit 124", async () => {
		const h = harness();
		expect(await run(["wait", "--timeout", "1"], h.io)).toBe(EXIT.timeout);
	});
});

describe("log", () => {
	test("shows my conversation, optionally with one peer, marking unread", async () => {
		peer("b-1", "builder");
		peer("c-1", "critic");
		const h = harness();
		await run(["send", "builder", "ping", "--as", "main"], h.io);
		deliver(root, reply("b-1", "cli-tester", "pong"));
		deliver(root, reply("c-1", "cli-tester", "meh"));
		const [file] = pending(root, "b-1");
		if (file) claim(root, "b-1", file);
		const log = harness();
		await run(["log", "builder"], log.io);
		expect(log.out.length).toBe(2);
		expect(log.out[0]).toContain("main → builder: ping");
		expect(log.out[1]).toContain("b-1 → you: pong  (unread)");
	});
});
