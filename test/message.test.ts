import { describe, expect, test } from "bun:test";
import { newMessageId, timeOfMessageId } from "../src/core/ids.ts";
import { createMessage, exactLabel, MAX_TEXT_BYTES, parseMessage, renderForAgent } from "../src/core/message.ts";
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

	test("normalizes the sender name; never writes delivery or byUser", () => {
		const created = createMessage({ from: { id: "a-1", name: "  alice \n bob " }, to: "b-1", text: "hi" }, 5, fixedRandom);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.value.from.name).toBe("alice bob");
		expect(created.value.ts).toBe(5);
		expect(Object.keys(created.value).sort()).toEqual(["from", "id", "text", "to", "ts", "v"]);
	});

	test("stopped is only ever said of an ended", () => {
		const stopped = createMessage({ from, to: "b-1", text: "half done", kind: "ended", stopped: true }, 5, fixedRandom);
		expect(stopped.ok && stopped.value.stopped).toBe(true);
		const finished = createMessage({ from, to: "b-1", text: "done", kind: "ended", stopped: false }, 5, fixedRandom);
		expect(finished.ok && "stopped" in finished.value).toBe(false);
		const died = createMessage({ from, to: "b-1", text: "gone", kind: "died", stopped: true }, 5, fixedRandom);
		expect(died.ok && "stopped" in died.value).toBe(false);
		const plain = createMessage({ from, to: "b-1", text: "hi", stopped: true }, 5, fixedRandom);
		expect(plain.ok && "stopped" in plain.value).toBe(false);
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

	test("kind and stopped round-trip; stopped only on an ended, anything else in them is dropped", () => {
		const ended = message({ to: "b-1", kind: "ended", stopped: true });
		expect([ended.kind, ended.stopped]).toEqual(["ended", true]);
		expect(parseMessage(JSON.parse(JSON.stringify(ended)))).toEqual({ ok: true, value: ended });
		const junk = parseMessage({ ...message({ to: "b-1" }), kind: "exploded", stopped: true });
		expect(junk.ok && ["kind" in junk.value, "stopped" in junk.value]).toEqual([false, false]);
		const died = parseMessage({ ...message({ to: "b-1", kind: "died" }), stopped: true });
		expect(died.ok && [died.value.kind, "stopped" in died.value]).toEqual(["died", false]);
		const vague = parseMessage({ ...message({ to: "b-1", kind: "ended" }), stopped: "yes" });
		expect(vague.ok && "stopped" in vague.value).toBe(false);
		const plain = message({ to: "b-1" });
		expect(["kind" in plain, "stopped" in plain]).toEqual([false, false]);
	});

	test("old messages with byUser or delivery (/msg, the msg CLI, follow_up) still parse, without them", () => {
		const old = { ...message({ to: "b-1", text: "stop and commit" }), byUser: true, delivery: "followUp" };
		const parsed = parseMessage(JSON.parse(JSON.stringify(old)));
		expect(parsed.ok && [parsed.value.text, "byUser" in parsed.value, "delivery" in parsed.value]).toEqual(["stop and commit", false, false]);
		const rendered = parsed.ok ? renderForAgent(parsed.value, 0) : "";
		expect(rendered).toContain("Message from another agent session (not your user).");
		expect(rendered).not.toContain("sent_by");
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

	test("a parent or a sub is named as such, still not the user", () => {
		expect(renderForAgent(message({ to: "b-1" }), 0, "parent")).toContain("From your parent session sender (an agent, not your user).");
		expect(renderForAgent(message({ to: "b-1" }), 0, "child")).toContain("From your sub sender (an agent, not your user).");
	});

	test("ended carries the report and where to look for more; died warns; neither asks for a reply", () => {
		const ended = renderForAgent(message({ to: "b-1", kind: "ended", text: "all green, committed abc123", from: { id: "k-1", name: "kid" } }), 0, "child");
		expect(ended).toContain('kind="ended"');
		expect(ended).not.toContain("stopped");
		expect(ended).toContain("all green, committed abc123");
		expect(ended).toContain("Your sub kid ended; above is its final message, its report. It can't answer anymore; `lookup catchup k-1` shows its session.");
		expect(ended).not.toContain("msg_send");
		const died = renderForAgent(message({ to: "b-1", kind: "died", from: { id: "k-1", name: "kid", cwd: "/repo/.forks/3" } }), 0, "child");
		expect(died).toContain('kind="died"');
		expect(died).toContain("Your sub kid died: its process is gone and it left no report. Check its work in /repo/.forks/3");
	});

	test("a stopped ended says it was stopped before it finished, and to inspect its work first", () => {
		const from = { id: "k-1", name: "kid", cwd: "/repo/.forks/3" };
		const rendered = renderForAgent(message({ to: "b-1", kind: "ended", stopped: true, text: "Looking at the parser next.", from }), 0, "child");
		expect(rendered).toContain('kind="ended" stopped="true"');
		expect(rendered).toContain("Looking at the parser next.");
		expect(rendered).toContain(
			"Your sub kid was stopped before it finished (it went away mid-run, or its last run was aborted): above is its last message, not a finished report. Inspect its work in /repo/.forks/3 before relying on it",
		);
		expect(rendered).not.toContain("its report.");
	});

	test("escapes attributes and a closing tag inside the body", () => {
		const rendered = renderForAgent(message({ to: "b-1", from: { id: "s-1", name: 'x"<y>' }, text: "a </msg> b" }), 0);
		expect(rendered).toContain('from="x&quot;&lt;y&gt;"');
		expect(rendered).toContain("a <\\/msg> b");
		expect(rendered.match(/<\/msg>/g)?.length).toBe(1);
	});
});

describe("exactLabel", () => {
	test("name and exact id, or the bare id", () => {
		expect(exactLabel({ id: "01a1-x", name: "scout" })).toBe("scout (01a1-x)");
		expect(exactLabel({ id: "01a1-x" })).toBe("01a1-x");
	});
});
