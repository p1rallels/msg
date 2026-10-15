import { describe, expect, test } from "bun:test";
import { newMessageId, timeOfMessageId } from "../src/core/ids.ts";
import { createMessage, MAX_TEXT_BYTES, parseMessage, renderForAgent, summarize } from "../src/core/message.ts";
import { agentDir, isValidId, mailboxDirs, msgRoot } from "../src/core/paths.ts";
import { fixedRandom, message } from "./helpers.ts";

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
});
