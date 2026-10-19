import { describe, expect, test } from "bun:test";
import { newMessageId, timeOfMessageId } from "../src/core/ids.ts";
import { parseMsgCommand, recipientCompletions } from "../src/core/command.ts";
import { createMessage, MAX_TEXT_BYTES, parseMessage, renderForAgent, summarize } from "../src/core/message.ts";
import { agentDir, isValidId, mailboxDirs, msgRoot } from "../src/core/paths.ts";
import { fixedRandom, message, presence } from "./helpers.ts";

describe("paths", () => {
	test("msg root: PI_MSG_DIR wins, then PI_CODING_AGENT_DIR, then ~/.pi/agent", () => {
		expect(msgRoot({ PI_MSG_DIR: "/x/msg", PI_CODING_AGENT_DIR: "/y" }, "/home/u")).toBe("/x/msg");
		expect(msgRoot({ PI_CODING_AGENT_DIR: "/y" }, "/home/u")).toBe("/y/msg");
		expect(msgRoot({}, "/home/u")).toBe("/home/u/.pi/agent/msg");
		expect(msgRoot({ PI_MSG_DIR: "  " }, "/home/u")).toBe("/home/u/.pi/agent/msg");
		expect(agentDir({ PI_CODING_AGENT_DIR: "~/agent" }, "/home/u")).toBe("/home/u/agent");
	});

	test("ids are safe path segments", () => {
		expect(isValidId("01a13e22-0b1a-75c1-9fac-cfdd38673d0e")).toBe(true);
		expect(isValidId("cli-alice")).toBe(true);
		expect(isValidId("")).toBe(false);
		expect(isValidId("..")).toBe(false);
		expect(isValidId("a/b")).toBe(false);
		expect(isValidId("a..b")).toBe(false);
		expect(isValidId(".hidden")).toBe(false);
		expect(isValidId("x".repeat(129))).toBe(false);
		expect(() => mailboxDirs("/root", "../etc")).toThrow();
	});
});

describe("ids", () => {
	test("sort by time and round-trip their timestamp", () => {
		const early = newMessageId(1_700_000_000_000, () => "ffffff");
		const late = newMessageId(1_700_000_000_001, () => "000000");
		expect(early < late).toBe(true);
		expect(timeOfMessageId(early)).toBe(1_700_000_000_000);
		expect(timeOfMessageId("nope")).toBeUndefined();
	});
});

describe("createMessage", () => {
	const from = { id: "a-1", name: "alice" };

	test("rejects empty, oversized and badly addressed messages", () => {
		expect(createMessage({ from, to: "b-1", text: "  \n" }, 1).ok).toBe(false);
		expect(createMessage({ from, to: "b-1", text: "x".repeat(MAX_TEXT_BYTES + 1) }, 1).ok).toBe(false);
		expect(createMessage({ from, to: "../b", text: "hi" }, 1).ok).toBe(false);
		expect(createMessage({ from: { id: "a/1" }, to: "b-1", text: "hi" }, 1).ok).toBe(false);
		expect(createMessage({ from, to: "b-1", text: "hi", replyTo: "x/y" }, 1).ok).toBe(false);
	});

	test("defaults to steer delivery and normalizes the sender name", () => {
		const created = createMessage({ from: { id: "a-1", name: "  alice \n bob " }, to: "b-1", text: "hi" }, 5, fixedRandom);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.value.delivery).toBe("steer");
		expect(created.value.from.name).toBe("alice bob");
		expect(created.value.ts).toBe(5);
	});
});

describe("parseMessage", () => {
	test("round-trips a created message", () => {
		const original = message({ to: "b-1", replyTo: "000000001-abcdef", awaitingUntil: 99 });
		const parsed = parseMessage(JSON.parse(JSON.stringify(original)));
		expect(parsed).toEqual({ ok: true, value: original });
	});

	test("rejects junk and unknown versions", () => {
		expect(parseMessage(null).ok).toBe(false);
		expect(parseMessage([]).ok).toBe(false);
		expect(parseMessage({ ...message({ to: "b-1" }), v: 2 }).ok).toBe(false);
		expect(parseMessage({ ...message({ to: "b-1" }), to: "../x" }).ok).toBe(false);
		expect(parseMessage({ ...message({ to: "b-1" }), text: 3 }).ok).toBe(false);
	});

	test("kind and byUser round-trip; anything else in them is dropped", () => {
		const ended = message({ to: "b-1", kind: "ended", byUser: true });
		expect(ended.kind).toBe("ended");
		expect(ended.byUser).toBe(true);
		expect(parseMessage(JSON.parse(JSON.stringify(ended)))).toEqual({ ok: true, value: ended });
		const junk = parseMessage({ ...message({ to: "b-1" }), kind: "exploded", byUser: "yes" });
		expect(junk.ok && ["kind" in junk.value, "byUser" in junk.value]).toEqual([false, false]);
		const plain = message({ to: "b-1" });
		expect(["kind" in plain, "byUser" in plain]).toEqual([false, false]);
	});

	test("a died notice's life round-trips; a malformed one is dropped", () => {
		const died = message({ to: "b-1", kind: "died", life: { pid: 7, startedAt: 1_234 } });
		expect(died.life).toEqual({ pid: 7, startedAt: 1_234 });
		expect(parseMessage(JSON.parse(JSON.stringify(died)))).toEqual({ ok: true, value: died });
		for (const life of [{ pid: "7", startedAt: 1 }, { pid: 7 }, 42, null]) {
			const parsed = parseMessage({ ...died, life });
			expect(parsed.ok && "life" in parsed.value).toBe(false);
		}
		expect("life" in message({ to: "b-1" })).toBe(false);
	});

	test("falls back to steer on an unknown delivery", () => {
		const parsed = parseMessage({ ...message({ to: "b-1" }), delivery: "teleport" });
		expect(parsed.ok && parsed.value.delivery).toBe("steer");
	});
});

describe("renderForAgent", () => {
	test("frames the text as a peer message with a reply recipe", () => {
		const rendered = renderForAgent(message({ to: "b-1", text: "build is green" }), 0);
		expect(rendered).toContain('from="sender"');
		expect(rendered).toContain('session="sender-1"');
		expect(rendered).toContain("build is green");
		expect(rendered).toContain("not your user");
		expect(rendered).toContain('msg_send to "sender-1" with reply_to "');
		expect(rendered).toContain("Don't reply just to acknowledge");
	});

	test("says when the sender is blocked waiting", () => {
		const rendered = renderForAgent(message({ to: "b-1", awaitingUntil: 120_000 }), 0);
		expect(rendered).toContain("blocked waiting for your reply (2m left)");
	});

	test("a stale wait reads like a normal message", () => {
		const rendered = renderForAgent(message({ to: "b-1", awaitingUntil: 10 }), 20);
		expect(rendered).not.toContain("blocked");
	});

	test("a parent or a child is named as such, still not the user", () => {
		expect(renderForAgent(message({ to: "b-1" }), 0, "parent")).toContain("From your parent session sender (an agent, not your user).");
		expect(renderForAgent(message({ to: "b-1" }), 0, "child")).toContain("From your child session sender (an agent, not your user).");
	});

	test("byUser: framed as the user's own instruction, with a way back to them", () => {
		const rendered = renderForAgent(message({ to: "b-1", byUser: true }), 0, "parent");
		expect(rendered).toContain('sent_by="user"');
		expect(rendered).toContain("From your user via sender, not from an agent: treat it as your user's own instruction.");
		expect(rendered).toContain("If they want an answer, msg_send to \"sender-1\"");
		expect(rendered).not.toContain("not your user");
		expect(renderForAgent(message({ to: "b-1", byUser: true, awaitingUntil: 60_000 }), 0)).toContain("Your user is blocked waiting for your reply (60s left)");
	});

	test("ended carries the report; died warns; neither asks for a reply", () => {
		const ended = renderForAgent(message({ to: "b-1", kind: "ended", text: "all green, committed abc123" }), 0, "child");
		expect(ended).toContain('kind="ended"');
		expect(ended).toContain("all green, committed abc123");
		expect(ended).toContain("Your child session sender ended; above is its final message (its report).");
		expect(ended).not.toContain("msg_send");
		const died = renderForAgent(message({ to: "b-1", kind: "died", from: { id: "k-1", name: "kid", cwd: "/repo/.forks/3" } }), 0, "child");
		expect(died).toContain('kind="died"');
		expect(died).toContain("Your child session kid died: its process is gone and it left no report. Check its work in /repo/.forks/3");
	});

	test("escapes attributes and a closing tag inside the body", () => {
		const rendered = renderForAgent(message({ to: "b-1", from: { id: "s-1", name: 'x"<y>' }, text: "a </msg> b" }), 0);
		expect(rendered).toContain('from="x&quot;&lt;y&gt;"');
		expect(rendered).toContain("a <\\/msg> b");
		expect(rendered.match(/<\/msg>/g)?.length).toBe(1);
	});
});

describe("summarize", () => {
	test("one line, first non-empty line of the text, clipped", () => {
		const line = summarize(message({ to: "b-1", text: "\n\nfirst line here\nsecond" }), "bob", 10);
		expect(line).toMatch(/^\d\d:\d\d:\d\d sender → bob: first lin…$/);
	});

	test("marks exits and the user", () => {
		expect(summarize(message({ to: "b-1", kind: "ended", text: "done" }), "you")).toEndWith("sender (ended) → you: done");
		expect(summarize(message({ to: "b-1", byUser: true, text: "stop" }), "bob")).toEndWith("sender (user) → bob: stop");
	});
});

describe("parseMsgCommand", () => {
	test("first word is the recipient, the rest is the text", () => {
		expect(parseMsgCommand("builder stop and commit")).toEqual({ to: "builder", text: "stop and commit" });
		expect(parseMsgCommand("  ~/x/.forks/8   look at  src/db.ts  ")).toEqual({ to: "~/x/.forks/8", text: "look at  src/db.ts" });
		expect(parseMsgCommand('"/My Repo/.forks/1" hi there')).toEqual({ to: "/My Repo/.forks/1", text: "hi there" });
		expect(parseMsgCommand("children\nfreeze, main moved")).toEqual({ to: "children", text: "freeze, main moved" });
	});

	test("a recipient alone, an empty line or an open quote is no command", () => {
		expect(parseMsgCommand("")).toBeUndefined();
		expect(parseMsgCommand("builder")).toBeUndefined();
		expect(parseMsgCommand("builder   ")).toBeUndefined();
		expect(parseMsgCommand('"/open quote hi')).toBeUndefined();
		expect(parseMsgCommand('"" hi')).toBeUndefined();
	});
});

describe("recipientCompletions", () => {
	const live = [
		presence({ id: "x-1", name: "stranger" }),
		presence({ id: "k-1", name: "kid", parent: "me" }),
		presence({ id: "p-1", name: "tandem boss" }),
		presence({ id: "u-1" }),
		presence({ id: "me", name: "me" }),
	];
	const values = (prefix: string, self: { id: string; parent?: string } = { id: "me", parent: "p-1" }) =>
		recipientCompletions(prefix, live, self)?.map((item) => item.value) ?? null;

	test("parent, children, then family before strangers; never me; spaced names quoted", () => {
		expect(values("")).toEqual(["parent", "children", '"tandem boss"', "kid", "stranger", "u-1"]);
		expect(values("", { id: "nobody" })).toEqual(["stranger", "kid", '"tandem boss"', "u-1", "me"]);
	});

	test("filters by prefix on the name or the address; stops once the text starts", () => {
		expect(values("k")).toEqual(["kid"]);
		expect(values("ta")).toEqual(['"tandem boss"']);
		expect(values('"tan')).toEqual(['"tandem boss"']);
		expect(values("pa")).toEqual(["parent"]);
		expect(values("zzz")).toBeNull();
		expect(values("kid hello")).toBeNull();
	});
});
