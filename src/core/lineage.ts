import { DELIVERED_TTL_MS } from "./housekeeping.ts";
import { ago, type Call, clipPreview, elapsed, exactLabel, type Life, MAX_TEXT_BYTES, type Message, partyLabel, type Relation, textBytes } from "./message.ts";
import { type Env, isValidId } from "./paths.ts";
import { type Mode, type PidProbe, pidAlive, type Presence, STALE_AFTER_MS } from "./registry.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A death is judged only while the child's last heartbeat is younger than this. Its `died` notice is
 * written after that heartbeat and housekeeping keeps delivered messages DELIVERED_TTL_MS, so the
 * notice that marks a death reported outlives every death still judged (the day of margin covers
 * coarse file times and clock steps). An older death goes unreported rather than reported again.
 */
export const DEATH_WINDOW_MS = DELIVERED_TTL_MS - 24 * 60 * 60_000;

/**
 * A sub is stalled once one tool call has run this long. Subs' longest legit commands take a minute or so; model
 * silence isn't a tool call and is pi's own to handle (httpIdleTimeoutMs cuts a quiet stream and retries it).
 */
export const STALLED_AFTER_MS = 10 * 60_000;

/** The stall threshold: PI_MSG_STALLED_AFTER_MS when it's a positive integer of ms (for tests), else STALLED_AFTER_MS. */
export const stalledAfter = (env: Env): number => {
	const raw = env.PI_MSG_STALLED_AFTER_MS?.trim() ?? "";
	const ms = /^\d+$/.test(raw) ? Number(raw) : 0;
	return ms > 0 && Number.isSafeInteger(ms) ? ms : STALLED_AFTER_MS;
};

/**
 * The session whose bash started this process: pi puts PI_SESSION_ID into every bash child's env and
 * pfs passes env through. pi-web's server env is nobody's parent, and a session never parents itself.
 */
export const inheritedParent = (env: Env, self: string, mode: Mode): string | undefined => {
	if (mode === "web") return undefined;
	const id = env.PI_SESSION_ID?.trim();
	return id && id !== self && isValidId(id) ? id : undefined;
};

/**
 * Why a pi started from `parent`'s bash must not run: `parent` is itself a sub, and subs don't start subs.
 * Undefined when it may run. A parent this store has no record of (an isolated test store) isn't known to be a sub.
 */
export const nestedRefusal = (parent: Presence | undefined): string | undefined =>
	parent?.parent === undefined ? undefined : `nested subs aren't allowed: ${exactLabel(parent)} is itself a sub. ask your parent instead.`;

export type Start = { readonly kind: "run"; readonly parent?: string } | { readonly kind: "refuse"; readonly reason: string };

/**
 * How a session starts: as the sub of the session whose bash started it (PI_SESSION_ID at start), top-level when
 * none did, or refused when that parent is itself a sub. `recordOf` reads a presence record from the store.
 */
export const startAs = (env: Env, self: string, mode: Mode, recordOf: (id: string) => Presence | undefined): Start => {
	const parent = inheritedParent(env, self, mode);
	if (parent === undefined) return { kind: "run" };
	const reason = nestedRefusal(recordOf(parent));
	return reason === undefined ? { kind: "run", parent } : { kind: "refuse", reason };
};

/** Where this life's agent runs stand: none yet, one going, or the last one settled, finished or aborted. */
export type RunState = "none" | "running" | "finished" | "aborted";

/** A session that ends mid-run, or after its last run was aborted (Esc, SIGTERM, an abort), ended without finishing: `stopped`. */
export const wasStopped = (run: RunState): boolean => run === "running" || run === "aborted";

/** What pi says about a tool call that starts (its `tool_execution_start` event). */
export interface CallStart {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
	/** Set when another tool made this call. */
	readonly parentToolCallId?: string | undefined;
}

/**
 * Whether a call can stall its session: an outer call (a nested one is covered by the call that made it), and not
 * msg_send (a sub blocked on its parent's answer isn't stuck: its parent is).
 */
export const canStall = (start: CallStart): boolean => !start.parentToolCallId && start.toolName !== "msg_send";

const argsText = (args: unknown): string => {
	if (!isRecord(args)) return "";
	if (typeof args.command === "string") return args.command;
	try {
		return Object.keys(args).length > 0 ? JSON.stringify(args) : "";
	} catch {
		return "";
	}
};

/** A call's arguments in one short line: bash's command, else the arguments as JSON. */
export const previewOf = (args: unknown): string | undefined => clipPreview(argsText(args)) || undefined;

/** The calls that can stall a session, oldest first, after one more starts at `now`. A call already there keeps its start. */
export const callStarted = (calls: readonly Call[], start: CallStart, now: number): readonly Call[] => {
	if (!canStall(start) || calls.some((call) => call.id === start.toolCallId)) return calls;
	const preview = previewOf(start.args);
	return [...calls, { id: start.toolCallId, name: start.toolName, ...(preview ? { preview } : {}), since: now }];
};

export const callEnded = (calls: readonly Call[], id: string): readonly Call[] => calls.filter((call) => call.id !== id);

/** Of parallel calls, the one that started first: the one a stall is judged by. */
export const oldestCall = (calls: readonly Call[]): Call | undefined =>
	calls.reduce<Call | undefined>((oldest, call) => (oldest === undefined || call.since < oldest.since ? call : oldest), undefined);

export const childrenOf = (records: readonly Presence[], id: string): Presence[] => records.filter((record) => record.parent === id);

export interface Family {
	/** Set whenever you have a parent, even one without a presence record. */
	readonly parentId: string | undefined;
	readonly parent: Presence | undefined;
	readonly children: readonly Presence[];
}

export const familyOf = (records: readonly Presence[], self: Pick<Presence, "id" | "parent">): Family => ({
	parentId: self.parent,
	parent: self.parent === undefined ? undefined : records.find((record) => record.id === self.parent),
	children: childrenOf(records, self.id),
});

export const hasFamily = (family: Family): boolean => family.parentId !== undefined || family.children.length > 0;

/** What `other` is to `self`: its parent, its child, or nothing. */
export const relationOf = (self: Pick<Presence, "id" | "parent">, otherId: string, other: Pick<Presence, "parent"> | undefined): Relation | undefined => {
	if (otherId === self.parent) return "parent";
	return other?.parent === self.id ? "child" : undefined;
};

export type DeathCause = "exited" | "silent";

export interface Death {
	readonly child: Presence;
	readonly cause: DeathCause;
}

export const lifeOf = (presence: Pick<Presence, "pid" | "startedAt">): Life => ({ pid: presence.pid, startedAt: presence.startedAt });

/**
 * True when `message` reports the death `child`'s record shows: a `died` from that child, about that
 * life, sent after its last heartbeat (a child that beats again after a `silent` notice can die again).
 * A notice without a life, from before notices named one, goes by the heartbeat alone.
 */
export const isNoticeOf = (message: Message, child: Presence): boolean =>
	message.kind === "died" &&
	message.from.id === child.id &&
	message.ts >= child.heartbeatAt &&
	(message.life === undefined || (message.life.pid === child.pid && message.life.startedAt === child.startedAt));

/** A live sub stuck in one tool call: the call its record shows, running past the stall threshold. */
export interface Stall {
	readonly child: Presence;
	readonly call: Call;
}

/** True when `message` reports this stall: a `stalled` from that child, about that life and that call. */
export const isStallNoticeOf = (message: Message, stall: Stall): boolean =>
	message.kind === "stalled" &&
	message.from.id === stall.child.id &&
	message.life?.pid === stall.child.pid &&
	message.life.startedAt === stall.child.startedAt &&
	message.call?.id === stall.call.id &&
	message.call.since === stall.call.since;

export interface Watch {
	/** Children that may still die: live ones, and silent ones still inside their grace. */
	readonly watched: readonly Presence[];
	readonly died: readonly Death[];
}

type Verdict = "watch" | "settled" | DeathCause;

const verdict = (child: Presence, notices: readonly Message[], now: number, awakeSince: number, probe: PidProbe, staleAfterMs: number): Verdict => {
	if (child.endedAt !== undefined) return "settled";
	const running = probe(child.pid);
	if (running && now - child.heartbeatAt <= staleAfterMs) return "watch";
	if (now - child.heartbeatAt >= DEATH_WINDOW_MS || notices.some((notice) => isNoticeOf(notice, child))) return "settled";
	if (!running) return "exited";
	return now - Math.max(child.heartbeatAt, awakeSince) > staleAfterMs ? "silent" : "watch";
};

/**
 * One look at your children. A child offline without having ended died, whether or not you saw it
 * live: its process is gone (`exited`), or it hasn't heartbeat for `staleAfterMs` of time you were
 * awake too (`silent`: after a sleep, or when you start, every heartbeat is stale until the children
 * beat again, so `awakeSince` restarts the clock). A death with a notice in `notices` was reported;
 * one older than DEATH_WINDOW_MS is let be.
 */
export const watchChildren = (
	children: readonly Presence[],
	notices: readonly Message[],
	now: number,
	awakeSince: number,
	probe: PidProbe = pidAlive,
	staleAfterMs = STALE_AFTER_MS,
): Watch => {
	const judged = children.map((child) => ({ child, verdict: verdict(child, notices, now, awakeSince, probe, staleAfterMs) }));
	return {
		watched: judged.flatMap(({ child, verdict: found }) => (found === "watch" ? [child] : [])),
		died: judged.flatMap(({ child, verdict: cause }) => (cause === "exited" || cause === "silent" ? [{ child, cause }] : [])),
	};
};

const stallOf = (child: Presence, now: number, awakeSince: number, stalledAfterMs: number): Stall | undefined => {
	const { call } = child;
	if (call === undefined || child.endedAt !== undefined || now - call.since >= DEATH_WINDOW_MS) return undefined;
	return now - Math.max(call.since, awakeSince) > stalledAfterMs ? { child, call } : undefined;
};

/**
 * The stalls among live children, as just read: a child whose oldest call (its record's `call`) has run longer than
 * `stalledAfterMs` of time you were awake too (after a sleep, or when you start, `awakeSince` restarts the clock, so
 * a machine that slept doesn't stall a call), and isn't reported in `notices` yet: once per call. A call older than
 * DEATH_WINDOW_MS is let be, as its notice may be pruned.
 */
export const stallsOf = (children: readonly Presence[], notices: readonly Message[], now: number, awakeSince: number, stalledAfterMs = STALLED_AFTER_MS): Stall[] =>
	children.flatMap((child) => {
		const stall = stallOf(child, now, awakeSince, stalledAfterMs);
		return stall === undefined || notices.some((notice) => isStallNoticeOf(notice, stall)) ? [] : [stall];
	});

export const diedText = (death: Death, now: number): string => {
	const { child } = death;
	const who = partyLabel(child);
	switch (death.cause) {
		case "exited":
			return `${who}'s process (pid ${child.pid}) is gone and its session never ended: it was killed or crashed. Last heartbeat ${ago(child.heartbeatAt, now)}.`;
		case "silent":
			return `${who} stopped responding: its last heartbeat was ${ago(child.heartbeatAt, now)}, though its process (pid ${child.pid}) still exists.`;
	}
};

/**
 * What stops a stalled sub, stuck command and all: SIGTERM to its pi, which kills every command it runs (each
 * leads its own process group, and pi kills the group) and ends, reporting `ended`, stopped.
 */
export const stopCommand = (child: Pick<Presence, "pid">): string => `kill ${child.pid}`;

const utc = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A stall's message text: what the sub is stuck in, for how long and since when, that it's alive, and how to stop it or leave it. */
export const stalledText = (stall: Stall, now: number): string => {
	const { child, call } = stall;
	const who = partyLabel(child);
	return [
		`${who} has been stuck in one tool call for ${elapsed(call.since, now)}, since ${utc(call.since)}:`,
		call.preview === undefined ? call.name : `${call.name}: ${call.preview}`,
		`It's alive (pid ${child.pid}, last heartbeat ${ago(child.heartbeatAt, now)}) but can't go on until that call returns.`,
		`To stop it, run \`${stopCommand(child)}\`: pi kills the commands it's running (each one's whole process group) and ends, and ${who} reports ended, stopped, with its last words.`,
		"Or leave it, if that's a legit long command: you won't hear about this call again.",
	].join("\n");
};

/**
 * What a session last said: its newest assistant text, and the error of its newest assistant message when that one
 * has no text: a failed run, or an abort (pi records an abort mid-tool as an error, not as `aborted`).
 */
export interface Words {
	readonly text?: string;
	readonly failure?: string;
}

const textOf = (message: Record<string, unknown>): string => {
	const parts: unknown[] = Array.isArray(message.content) ? message.content : [];
	return parts
		.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n")
		.trim();
};

/** Words after one more message. Only assistant messages count: one with text replaces the text, one without keeps it and says why (its error, if any). */
export const noteWords = (words: Words, message: unknown): Words => {
	if (!isRecord(message) || message.role !== "assistant") return words;
	const text = textOf(message);
	if (text) return { text };
	const failure = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	return { ...(words.text === undefined ? {} : { text: words.text }), ...(failure ? { failure } : {}) };
};

/** Words over a session branch, oldest entry first. */
export const wordsIn = (entries: readonly unknown[]): Words =>
	entries.reduce<Words>((words, entry) => (isRecord(entry) && entry.type === "message" ? noteWords(words, entry.message) : words), {});

/**
 * What an ended sub's report says: its newest text, or the error its last run failed with. A stopped sub's error is
 * the stop's own echo, so it says its newest text, and `stopped` tells the rest.
 */
export const reportWords = (words: Words, stopped: boolean): string | undefined =>
	stopped || words.failure === undefined ? words.text : `(failed with an error: ${words.failure})`;

const morePointer = (rest: number, sessionId: string): string => `… [+${rest} chars: lookup last ${sessionId} -k assistant --full]`;

/** The longest head of `text` that fits in `bytes` of UTF-8, never half a character. */
const headInBytes = (text: string, bytes: number): string =>
	Buffer.from(text, "utf8")
		.subarray(0, Math.max(0, bytes))
		.toString("utf8")
		.replace(/\uFFFD+$/u, "");

/**
 * An ended sub's message text: its whole final message. Only a message past msg's limit (`maxBytes`) is cut, near
 * the limit at a word boundary, pointing at the rest; the result always fits.
 */
export const endedText = (words: string | undefined, sessionId: string, maxBytes = MAX_TEXT_BYTES): string => {
	const text = words?.trim() || "(it ended without a final message)";
	if (textBytes(text) <= maxBytes) return text;
	const head = headInBytes(text, maxBytes - textBytes(morePointer(text.length, sessionId)));
	const space = head.search(/\s\S*$/);
	const cut = (space >= head.length * 0.8 ? head.slice(0, space) : head).trimEnd();
	return `${cut}${morePointer(text.length - cut.length, sessionId)}`;
};
