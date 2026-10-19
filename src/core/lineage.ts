import { DELIVERED_TTL_MS } from "./housekeeping.ts";
import { ago, exactLabel, type Life, MAX_TEXT_BYTES, type Message, partyLabel, type Relation, textBytes } from "./message.ts";
import { type Env, isValidId } from "./paths.ts";
import { type Mode, type PidProbe, pidAlive, type Presence, STALE_AFTER_MS } from "./registry.ts";

/**
 * A death is judged only while the child's last heartbeat is younger than this. Its `died` notice is
 * written after that heartbeat and housekeeping keeps delivered messages DELIVERED_TTL_MS, so the
 * notice that marks a death reported outlives every death still judged (the day of margin covers
 * coarse file times and clock steps). An older death goes unreported rather than reported again.
 */
export const DEATH_WINDOW_MS = DELIVERED_TTL_MS - 24 * 60 * 60_000;

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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
