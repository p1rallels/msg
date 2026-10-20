import type { Env } from "./paths.ts";
import type { Presence } from "./registry.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * How long a sub's bash call runs when it sets no `timeout`. Nobody watches a sub's terminal, so a command that never
 * returns (a dev server in the foreground, `tail -f`, a prompt waiting on stdin) would hold the sub until its parent
 * hears it stalled. Subs' longest commands so far took ~3 min; test suites and CI waits take 2-5.
 */
export const SUB_TIMEOUT_MS = 5 * 60_000;

/** The longest timeout pi's bash takes (setTimeout's limit): a longer one fails the call. */
const MAX_BASH_TIMEOUT_MS = 2_147_483_647;

/**
 * The timeout a sub's bash calls get, in seconds (bash's unit; it takes fractions): PI_MSG_SUB_TIMEOUT_MS when it's a
 * positive integer of ms that bash can take (for tests), else SUB_TIMEOUT_MS.
 */
export const subTimeout = (env: Env): number => {
	const raw = env.PI_MSG_SUB_TIMEOUT_MS?.trim() ?? "";
	const ms = /^\d+$/.test(raw) ? Number(raw) : 0;
	return (ms > 0 && ms <= MAX_BASH_TIMEOUT_MS ? ms : SUB_TIMEOUT_MS) / 1_000;
};

/** A tool call about to run, as pi's `tool_call` event has it. */
export interface PendingCall {
	readonly toolName: string;
	readonly input: unknown;
}

/** No `timeout`: none at all, or null (strict tool schemas have models send null for an optional field they leave out). */
const setsNone = (input: Record<string, unknown>): boolean => input.timeout === undefined || input.timeout === null;

/**
 * The timeout msg gives a call, in seconds: `seconds` for a sub's bash call that sets no `timeout`, else none. A call
 * that sets its own keeps it, whatever it is; top-level sessions and parents get none (a human watches those).
 */
export const defaultTimeout = (session: Pick<Presence, "parent">, call: PendingCall, seconds: number): number | undefined =>
	session.parent !== undefined && call.toolName === "bash" && isRecord(call.input) && setsNone(call.input) ? seconds : undefined;

/** A part of a tool result's content, as pi has it: text, or an image. */
export interface Part {
	readonly type: string;
	readonly text?: string;
}

/** How a tool call came out, as pi's `tool_result` event has it. */
export interface Outcome<T extends Part = Part> {
	readonly content: readonly T[];
	readonly isError: boolean;
}

/** pi's bash ends the result of a call it killed at its timeout with this line, `seconds` as the call gave them. */
const timedOutLine = (seconds: number): string => `Command timed out after ${seconds} seconds`;

const endsTimedOut = <T extends Part>(part: T | undefined, seconds: number): part is T & { readonly text: string } => {
	const line = timedOutLine(seconds);
	return part?.type === "text" && typeof part.text === "string" && (part.text === line || part.text.endsWith(`\n${line}`));
};

/** True when pi killed the call at a timeout of `seconds`: an error whose text ends with pi's line for that. */
export const timedOut = (outcome: Outcome, seconds: number): boolean => outcome.isError && endsTimedOut(outcome.content.at(-1), seconds);

/** Seconds the way msg says them: `5 min`, `90 s`, `2.5 s`. */
export const secondsText = (seconds: number): string => (seconds > 0 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`);

/** The line msg adds to a call it gave `seconds` that timed out: where the limit came from, and what to do instead. */
export const timeoutNote = (seconds: number): string =>
	`That ${secondsText(seconds)} limit is msg's default for a sub's bash calls that set no \`timeout\` (nobody watches a sub's terminal). Run a server or watcher in the background with its output in a file (\`cmd > /tmp/x.log 2>&1 &\`); rerun a legit long command with a bigger \`timeout\`.`;

/**
 * A call's content with msg's note as one more line, when msg gave the call its timeout (`given`, in seconds) and pi
 * killed it at that timeout. Undefined for every other call: one with its own timeout, one that finished, one that
 * failed some other way.
 */
export const withTimeoutNote = <T extends Part>(outcome: Outcome<T>, given: number | undefined): T[] | undefined => {
	const last = outcome.content.at(-1);
	if (given === undefined || !outcome.isError || !endsTimedOut(last, given)) return undefined;
	return [...outcome.content.slice(0, -1), { ...last, text: `${last.text}\n${timeoutNote(given)}` }];
};
