import { describe, expect, test } from "bun:test";
import { defaultTimeout, type Outcome, type Part, SUB_TIMEOUT_MS, secondsText, subTimeout, timedOut, timeoutNote, withTimeoutNote } from "../src/core/timeout.ts";
import { presence } from "./helpers.ts";

const PARENT = "01a152a0-f00d-72aa-a896-d904c458282b";
const SELF = "01a152d4-d2c3-751d-ab2f-1d14f1974871";

const sub = presence({ id: SELF, parent: PARENT });
const topLevel = presence({ id: SELF });
const bash = (input: Record<string, unknown>) => ({ toolName: "bash", input });

/** What pi's bash returns for a call it killed at its timeout: the output so far, then its line. */
const killedAt = (seconds: number, output = "listening on :3000"): Outcome => ({
	content: [{ type: "text", text: `${output}\n\nCommand timed out after ${seconds} seconds` }],
	isError: true,
});

const failed = (text: string): Outcome => ({ content: [{ type: "text", text }], isError: true });

describe("a sub's bash calls get a default timeout", () => {
	test("a sub's bash call without a timeout gets 5 minutes: 300 s", () => {
		expect(SUB_TIMEOUT_MS).toBe(5 * 60_000);
		expect(defaultTimeout(sub, bash({ command: "npm run dev" }), subTimeout({}))).toBe(300);
	});

	test("a null timeout is none: strict tool schemas have models send null for a field they leave out", () => {
		expect(defaultTimeout(sub, bash({ command: "npm run dev", timeout: null }), 300)).toBe(300);
		expect(defaultTimeout(sub, bash({ command: "npm run dev", timeout: undefined }), 300)).toBe(300);
	});

	test("a call that sets its own timeout keeps it, whatever it is", () => {
		for (const own of [20, 0.5, 3_600, 86_400, 0, -1, "60"]) expect([own, defaultTimeout(sub, bash({ command: "bun run e2e", timeout: own }), 300)]).toEqual([own, undefined]);
	});

	test("a top-level session's calls get none, and neither do a parent's", () => {
		expect(defaultTimeout(topLevel, bash({ command: "npm run dev" }), 300)).toBeUndefined();
		expect(defaultTimeout(presence({ id: PARENT }), bash({ command: "pfs wait" }), 300)).toBeUndefined();
	});

	test("other tools are untouched", () => {
		for (const toolName of ["read", "write", "msg_send", "powershell", "codemode", "web_fetch", "Bash"]) {
			expect([toolName, defaultTimeout(sub, { toolName, input: { command: "x", path: "a.ts" } }, 300)]).toEqual([toolName, undefined]);
		}
	});

	test("a nested call (another tool's ctx.executeTool) is treated the same", () => {
		const nested = { type: "tool_call", toolCallId: "toolu_01/1", parentToolCallId: "toolu_01", toolName: "bash", input: { command: "sleep 619" } };
		expect(defaultTimeout(sub, nested, 300)).toBe(300);
		expect(defaultTimeout(topLevel, nested, 300)).toBeUndefined();
		expect(defaultTimeout(sub, { ...nested, input: { command: "sleep 619", timeout: 9 } }, 300)).toBeUndefined();
	});

	test("an input that isn't an object gets none", () => {
		for (const input of [undefined, null, "sleep 9", ["sleep 9"]]) expect(defaultTimeout(sub, { toolName: "bash", input }, 300)).toBeUndefined();
	});

	test("the timeout is the caller's", () => {
		expect(defaultTimeout(sub, bash({ command: "sleep 617" }), 2.5)).toBe(2.5);
	});
});

describe("subTimeout: PI_MSG_SUB_TIMEOUT_MS", () => {
	test("a positive integer of ms, in seconds (bash's unit, fractions allowed)", () => {
		expect(subTimeout({ PI_MSG_SUB_TIMEOUT_MS: "3000" })).toBe(3);
		expect(subTimeout({ PI_MSG_SUB_TIMEOUT_MS: "2500" })).toBe(2.5);
		expect(subTimeout({ PI_MSG_SUB_TIMEOUT_MS: " 1\n" })).toBe(0.001);
		expect(subTimeout({ PI_MSG_SUB_TIMEOUT_MS: "2147483647" })).toBe(2_147_483.647);
	});

	test("unset, junk, zero, negative, or longer than bash takes: 5 minutes", () => {
		expect(subTimeout({})).toBe(300);
		for (const junk of ["", " ", "0", "-5", "-3000", "1.5", "3e3", "0x10", "abc", "3000ms", "2147483648", "99999999999999999999"]) {
			expect([junk, subTimeout({ PI_MSG_SUB_TIMEOUT_MS: junk })]).toEqual([junk, 300]);
		}
	});
});

describe("timed out", () => {
	test("an error ending with pi's timeout line for that many seconds", () => {
		expect(timedOut(killedAt(300), 300)).toBe(true);
		expect(timedOut(failed("Command timed out after 300 seconds"), 300)).toBe(true);
		expect(timedOut(killedAt(2.5), 2.5)).toBe(true);
	});

	test("at another timeout: not msg's", () => {
		expect(timedOut(killedAt(120), 300)).toBe(false);
		expect(timedOut(killedAt(3000), 300)).toBe(false);
	});

	test("other failures: an exit code, an abort, a missing folder, a blocked call", () => {
		expect(timedOut(failed("FAIL test/x.test.ts\n\nCommand exited with code 1"), 300)).toBe(false);
		expect(timedOut(failed("partial output\n\nCommand aborted"), 300)).toBe(false);
		expect(timedOut(failed("Working directory does not exist: /gone\nCannot execute bash commands."), 300)).toBe(false);
		expect(timedOut(failed("Tool execution was blocked"), 300)).toBe(false);
	});

	test("the line inside the output, not pi's last word, doesn't count", () => {
		expect(timedOut(failed("Command timed out after 300 seconds\n\nCommand exited with code 124"), 300)).toBe(false);
		expect(timedOut(failed("retry: Command timed out after 300 seconds"), 300)).toBe(false);
	});

	test("a call that succeeded never timed out, whatever it printed", () => {
		expect(timedOut({ ...killedAt(300), isError: false }, 300)).toBe(false);
	});

	test("no text at the end, or none at all", () => {
		expect(timedOut({ content: [], isError: true }, 300)).toBe(false);
		expect(timedOut({ content: [...killedAt(300).content, { type: "image" }], isError: true }, 300)).toBe(false);
	});
});

describe("the note on a defaulted call that timed out", () => {
	const note =
		"That 5 min limit is msg's default for a sub's bash calls that set no `timeout` (nobody watches a sub's terminal). Run a server or watcher in the background with its output in a file (`cmd > /tmp/x.log 2>&1 &`); rerun a legit long command with a bigger `timeout`.";

	test("timeoutNote: where the limit came from, and what to do, on one line", () => {
		expect(timeoutNote(300)).toBe(note);
		expect(timeoutNote(300)).not.toContain("\n");
		expect(timeoutNote(3)).toStartWith("That 3 s limit is msg's default");
	});

	test("secondsText: whole minutes as min, the rest as s", () => {
		expect([300, 60, 3_600, 90, 3, 2.5, 0.001].map(secondsText)).toEqual(["5 min", "1 min", "60 min", "90 s", "3 s", "2.5 s", "0.001 s"]);
	});

	test("a call msg gave the timeout that timed out gets one more line, right after pi's", () => {
		expect(withTimeoutNote(killedAt(300), 300)).toEqual([{ type: "text", text: `listening on :3000\n\nCommand timed out after 300 seconds\n${note}` }]);
		expect(withTimeoutNote(failed("Command timed out after 2.5 seconds"), 2.5)).toEqual([{ type: "text", text: `Command timed out after 2.5 seconds\n${timeoutNote(2.5)}` }]);
	});

	test("the rest of the result is kept as it is", () => {
		const parts: (Part & { readonly textSignature?: string })[] = [{ type: "image" }, { type: "text", text: "Command timed out after 300 seconds", textSignature: "sig" }];
		const noted = withTimeoutNote({ content: parts, isError: true }, 300);
		expect(noted?.[0]).toBe(parts[0]);
		expect(noted?.[1]).toEqual({ type: "text", text: `Command timed out after 300 seconds\n${note}`, textSignature: "sig" });
		expect(parts[1]?.text).toBe("Command timed out after 300 seconds");
	});

	test("not on the defaulted call's other failures, nor when it finished", () => {
		expect(withTimeoutNote(failed("FAIL\n\nCommand exited with code 1"), 300)).toBeUndefined();
		expect(withTimeoutNote(failed("Command aborted"), 300)).toBeUndefined();
		expect(withTimeoutNote({ ...killedAt(300), isError: false }, 300)).toBeUndefined();
	});

	test("not on a call with its own timeout: msg gave it none", () => {
		const own = bash({ command: "bun run e2e", timeout: 20 });
		expect(withTimeoutNote(killedAt(20), defaultTimeout(sub, own, 300))).toBeUndefined();
		expect(withTimeoutNote(killedAt(300), undefined)).toBeUndefined();
	});

	test("not when the call timed out at another timeout than msg's", () => {
		expect(withTimeoutNote(killedAt(120), 300)).toBeUndefined();
	});
});
