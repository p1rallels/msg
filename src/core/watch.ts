import { type Death, diedText, isNoticeOf, lifeOf, type Watch, watchChildren } from "./lineage.ts";
import { messagesSince } from "./maildir.ts";
import type { Message } from "./message.ts";
import { recordFile } from "./paths.ts";
import { type PidProbe, pidAlive, type Presence, readPresence, readSessions, type Sessions, STALE_AFTER_MS } from "./registry.ts";
import { fail, type Result } from "./result.ts";
import { postExit, senderOf } from "./send.ts";

/** What a session keeps between looks at its children. */
export interface ChildWatch {
	/** `sessions/` at the last look: a file not in it is a new record, the only kind a quick look reads. */
	readonly files: ReadonlySet<string>;
	/** Children that may still die, as last read. A quick look probes their pids instead of reading them. */
	readonly watched: readonly Presence[];
	/** `died` notices this session posted or found in its inbox: deaths already reported. */
	readonly notices: readonly Message[];
}

export const newWatch = (): ChildWatch => ({ files: new Set(), watched: [], notices: [] });

/** `full` reads every record (resumed children, the status line); `quick` only what's new or outdated. */
export type Scope = "full" | "quick";

export interface Look {
	readonly watch: ChildWatch;
	/** The records this look read: every one on a full look. */
	readonly records: readonly Presence[];
	readonly posted: readonly Message[];
	readonly failed: readonly { readonly death: Death; readonly error: string }[];
}

/** A watched child's record may have moved on: its process is gone (did it end?) or its heartbeat as last read is stale. */
const outdated = (child: Presence, now: number, probe: PidProbe, staleAfterMs: number): boolean =>
	!probe(child.pid) || now - child.heartbeatAt > staleAfterMs;

/** The record files a quick look reads: new since the last look, or an outdated watched child's. Nothing else. */
export const filesToRead = (watch: ChildWatch, now: number, probe: PidProbe = pidAlive, staleAfterMs = STALE_AFTER_MS): ((file: string) => boolean) => {
	const reread = new Set(watch.watched.filter((child) => outdated(child, now, probe, staleAfterMs)).map((child) => recordFile(child.id)));
	return (file) => !watch.files.has(file) || reread.has(file);
};

/** Who to judge after a look: your children among the records read, and the watched ones it didn't read whose file is still there. */
export const childrenAfter = (watched: readonly Presence[], look: Sessions, selfId: string): Presence[] => {
	const read = new Set(look.records.map((record) => record.id));
	const kept = watched.filter((child) => !read.has(child.id) && look.files.has(recordFile(child.id)));
	return [...kept, ...look.records.filter((record) => record.parent === selfId)];
};

/**
 * Judges deaths again on records read after the probes that found them: a child that ends cleanly
 * can mark its record and exit between a read and a probe, and once its process is gone its record is final.
 */
const confirm = (root: string, selfId: string, deaths: readonly Death[], notices: readonly Message[], now: number, awakeSince: number, probe: PidProbe): Watch => {
	const fresh = deaths.flatMap((death) => readPresence(root, death.child.id) ?? []).filter((record) => record.parent === selfId);
	return watchChildren(fresh, notices, now, awakeSince, probe);
};

/** The `died` notices in your inbox, new/ and cur/, that could report these deaths: none is sent before the heartbeat it follows. */
const noticesFor = (root: string, selfId: string, deaths: readonly Death[]): Message[] =>
	messagesSince(root, selfId, Math.min(...deaths.map((death) => death.child.heartbeatAt))).filter((message) => message.kind === "died");

const byId = (messages: readonly Message[]): Message[] => [...new Map(messages.map((message) => [message.id, message])).values()];

/** Into your own inbox, from the child, naming its life, and never dated before the heartbeat it follows. */
const postDied = (root: string, selfId: string, death: Death, now: number): Result<Message> => {
	try {
		return postExit(root, senderOf(death.child), selfId, { kind: "died", life: lifeOf(death.child) }, diedText(death, now), Math.max(now, death.child.heartbeatAt));
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
};

/**
 * One look after your children: one readdir of `sessions/`, reading every record (`full`) or only new
 * and outdated ones (`quick`). A death is confirmed on a fresh record, then checked against your inbox,
 * where the `died` notices are the evidence it was reported (by this run or an earlier one, live or
 * not), and the rest are posted there. A post that fails isn't evidence, so the next full look retries.
 */
export const lookAfterChildren = (
	root: string,
	selfId: string,
	watch: ChildWatch,
	scope: Scope,
	now: number,
	awakeSince: number,
	probe: PidProbe = pidAlive,
): Look => {
	const look = readSessions(root, scope === "full" ? () => true : filesToRead(watch, now, probe));
	const judged = watchChildren(childrenAfter(watch.watched, look, selfId), watch.notices, now, awakeSince, probe);
	if (judged.died.length === 0) return { watch: { files: look.files, watched: judged.watched, notices: watch.notices }, records: look.records, posted: [], failed: [] };
	const confirmed = confirm(root, selfId, judged.died, watch.notices, now, awakeSince, probe);
	const notices = confirmed.died.length === 0 ? watch.notices : byId([...watch.notices, ...noticesFor(root, selfId, confirmed.died)]);
	const due = confirmed.died.filter((death) => !notices.some((notice) => isNoticeOf(notice, death.child)));
	const attempts = due.map((death) => ({ death, result: postDied(root, selfId, death, now) }));
	const posted = attempts.flatMap(({ result }) => (result.ok ? [result.value] : []));
	return {
		watch: { files: look.files, watched: [...judged.watched, ...confirmed.watched], notices: [...notices, ...posted] },
		records: look.records,
		posted,
		failed: attempts.flatMap(({ death, result }) => (result.ok ? [] : [{ death, error: result.error }])),
	};
};
