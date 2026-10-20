import { describe, expect, test } from "bun:test";
import { LIST_DESCRIPTION, PROMPT_GUIDELINES, SEND_DESCRIPTION, SEND_TO } from "../src/core/guide.ts";

const bullet = (marker: string): string => {
	const found = PROMPT_GUIDELINES.find((line) => line.includes(marker));
	if (found === undefined) throw new Error(`no guideline mentions ${marker}`);
	return found;
};

describe("guidelines per role, in every session's prompt", () => {
	test("everyone: <msg> is an agent, not the user; never acknowledge", () => {
		const all = bullet("<msg>");
		expect(all).toContain("never from your user");
		expect(all).toContain("Never send a message just to acknowledge or thank.");
	});

	test("a sub: only its parent, wait_seconds when blocked, no pi sessions, its final message is its report", () => {
		const sub = bullet("You're its sub");
		expect(sub).toContain('message only your parent (to: "parent")');
		expect(sub).toContain("ask with wait_seconds");
		expect(sub).toContain("never start pi sessions");
		expect(sub).toContain("Your final message is your report");
	});

	test("a parent: woken by its subs, ends its turn instead of polling, answers with reply_to, reads reports in full, lookup for more", () => {
		const parent = bullet("are your subs");
		expect(parent).toContain('reports (kind="ended"), deaths (kind="died") and stalls (kind="stalled") wake you');
		expect(parent).toContain("end your turn to wait");
		expect(parent).toContain("never poll");
		expect(parent).toContain("reply_to");
		expect(parent).toContain("Read each report in full");
		expect(parent).toContain("`lookup`");
	});

	test("a parent: a stalled sub is alive; wait, lookup it, or stop it with the notice's command", () => {
		const parent = bullet("are your subs");
		expect(parent).toContain("A stalled sub is alive but stuck in one tool call: wait if that's a legit long command, `lookup` its session, or stop it with the notice's command.");
	});

	test("a top-level session: exact id, or a live folder or name; someone else's sub only through its parent", () => {
		const top = bullet("No parent?");
		expect(top).toContain("exact session id");
		expect(top).toContain("folder or name with exactly one live session");
		expect(top).toContain("someone else's sub only through its parent");
	});

	test("nothing cut is mentioned: msg_wait, follow_up, set_name, /msg, the cli", () => {
		const everything = [...PROMPT_GUIDELINES, LIST_DESCRIPTION, SEND_DESCRIPTION, SEND_TO].join("\n");
		for (const gone of [/msg_wait/, /follow_up/, /delivery/, /set_name/, /\/msg\b/, /\bcli\b/i, /prefix/]) expect(everything).not.toMatch(gone);
	});
});
