import { DELIVERED_TTL_MS } from "./housekeeping.ts";
import { ago, type Life, type Message, partyLabel, type Relation } from "./message.ts";
import { type Env, isValidId } from "./paths.ts";
import { type Mode, type PidProbe, pidAlive, type Presence, STALE_AFTER_MS } from "./registry.ts";

/** Last words longer than this are cut: the parent reads the gist, the session file keeps the rest. */
export const LAST_WORDS_MAX = 600;

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
	if (mode === "web" || mode === "cli") return undefined;
	const id = env.PI_SESSION_ID?.trim();
	return id && id !== self && isValidId(id) ? id : undefined;
};

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

/** The text of an assistant message, or its error when it has none. Undefined for any other message. */
export const assistantWords = (message: unknown): string | undefined => {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	const parts: unknown[] = Array.isArray(message.content) ? message.content : [];
	const text = parts
		.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n")
		.trim();
	if (text) return text;
	const error = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	return error ? `(stopped with an error: ${error})` : undefined;
};

const entryWords = (entry: unknown): string | undefined => (isRecord(entry) && entry.type === "message" ? assistantWords(entry.message) : undefined);

/** The newest assistant message in a session branch that says something. */
export const lastWordsIn = (entries: readonly unknown[]): string | undefined => {
	const found = [...entries].reverse().find((entry) => entryWords(entry) !== undefined);
	return found === undefined ? undefined : entryWords(found);
};

/** An ended session's message text: its last words, cut near `max` at a word boundary, pointing at the rest. */
export const endedText = (words: string | undefined, sessionId: string, max = LAST_WORDS_MAX): string => {
	const text = words?.trim() || "(it ended without a final message)";
	if (text.length <= max) return text;
	const head = text.slice(0, max);
	const space = head.search(/\s\S*$/);
	const cut = (space >= max * 0.8 ? head.slice(0, space) : head).trimEnd();
	return `${cut}… [+${text.length - cut.length} chars: lookup last ${sessionId} -k assistant --full]`;
};
