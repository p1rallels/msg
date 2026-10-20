import { callGroup, type ProcessTable, type ProcRow, psTable } from "./group.ts";
import { type Death, diedText, isNoticeOf, isStallNoticeOf, lifeOf, type Stall, STALLED_AFTER_MS, stalledText, stallsOf, type Watch, watchChildren } from "./lineage.ts";
import { messagesSince } from "./maildir.ts";
import type { Kind, Message } from "./message.ts";
import { recordFile } from "./paths.ts";
import { type PidProbe, pidAlive, type Presence, readPresence, readSessions, type Sessions, STALE_AFTER_MS } from "./registry.ts";
import { fail, type Result } from "./result.ts";
import { type Exit, postExit, senderOf } from "./send.ts";

/** What a session keeps between looks at its children. */
export interface ChildWatch {
	/** `sessions/` at the last look: a file not in it is a new record, the only kind a quick look reads. */
	readonly files: ReadonlySet<string>;
	/** Children that may still die, as last read. A quick look probes their pids instead of reading them. */
	readonly watched: readonly Presence[];
	/** `died` and `stalled` notices this session posted or found in its inbox: deaths and stalls already reported. */
	readonly notices: readonly Message[];
}

export const newWatch = (): ChildWatch => ({ files: new Set(), watched: [], notices: [] });

/** `full` reads every record (resumed children, the status line); `quick` only what's new or outdated. */
export type Scope = "full" | "quick";

/** What a parent's own msg reports about its subs into its own inbox. */
type Notice = Extract<Kind, "died" | "stalled">;

/** A notice that couldn't be posted: about which child, of what, and why. */
export interface Failure {
	readonly child: Presence;
	readonly kind: Notice;
	readonly error: string;
}

export interface Look {
	readonly watch: ChildWatch;
	/** The records this look read: every one on a full look. */
	readonly records: readonly Presence[];
	readonly posted: readonly Message[];
	readonly failed: readonly Failure[];
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

/** The notices of `kind` in your inbox, new/ and cur/, that could report something that happened at one of `times`: none is sent before it. */
const evidence = (root: string, selfId: string, kind: Notice, times: readonly number[]): Message[] =>
	times.length === 0 ? [] : messagesSince(root, selfId, Math.min(...times)).filter((message) => message.kind === kind);

const byId = (messages: readonly Message[]): Message[] => [...new Map(messages.map((message) => [message.id, message])).values()];

/** Into your own inbox, from the child, never dated before `notBefore` (the moment its evidence is looked up from). */
const postNotice = (root: string, selfId: string, child: Presence, exit: Exit, text: string, now: number, notBefore: number): Result<Message> => {
	try {
		return postExit(root, senderOf(child), selfId, exit, text, Math.max(now, notBefore));
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
};

interface Reported {
	readonly notices: readonly Message[];
	readonly posted: readonly Message[];
	readonly failed: readonly Failure[];
}

const reported = (notices: readonly Message[], attempts: readonly { readonly child: Presence; readonly kind: Notice; readonly result: Result<Message> }[]): Reported => {
	const posted = attempts.flatMap(({ result }) => (result.ok ? [result.value] : []));
	return {
		notices: [...notices, ...posted],
		posted,
		failed: attempts.flatMap(({ child, kind, result }) => (result.ok ? [] : [{ child, kind, error: result.error }])),
	};
};

/**
 * Deaths are confirmed on a fresh record, then checked against your inbox, where the `died` notices are the evidence
 * a death was reported (none is sent before the heartbeat it follows); the rest are posted there.
 */
const reportDeaths = (root: string, selfId: string, judged: Watch, notices: readonly Message[], now: number, awakeSince: number, probe: PidProbe): Reported & { readonly watched: readonly Presence[] } => {
	if (judged.died.length === 0) return { watched: judged.watched, notices, posted: [], failed: [] };
	const confirmed = confirm(root, selfId, judged.died, notices, now, awakeSince, probe);
	const known = byId([...notices, ...evidence(root, selfId, "died", confirmed.died.map((death) => death.child.heartbeatAt))]);
	const due = confirmed.died.filter((death) => !known.some((notice) => isNoticeOf(notice, death.child)));
	const attempts = due.map((death) => ({
		child: death.child,
		kind: "died" as const,
		result: postNotice(root, selfId, death.child, { kind: "died", life: lifeOf(death.child) }, diedText(death, now), now, death.child.heartbeatAt),
	}));
	return { watched: [...judged.watched, ...confirmed.watched], ...reported(known, attempts) };
};

/** Only a bash call has a process group to look up: pi spawns each bash command as a group of its own. */
const inBash = (stall: Stall): boolean => stall.call.name === "bash";

const groupOf = (stall: Stall, procs: readonly ProcRow[] | undefined, now: number): number | undefined =>
	procs === undefined || !inBash(stall) ? undefined : callGroup(procs, stall.child.pid, stall.call.since, now);

/**
 * Stalls are checked against your inbox the same way: `stalled` notices, none sent before the call it's about started.
 * The machine's processes are listed once, and only when a stall about to be reported is on a bash call, so its notice
 * can name the command's process group.
 */
const reportStalls = (
	root: string,
	selfId: string,
	children: readonly Presence[],
	notices: readonly Message[],
	now: number,
	awakeSince: number,
	stalledAfterMs: number,
	table: ProcessTable,
): Reported => {
	const found = stallsOf(children, notices, now, awakeSince, stalledAfterMs);
	if (found.length === 0) return { notices, posted: [], failed: [] };
	const known = byId([...notices, ...evidence(root, selfId, "stalled", found.map((stall) => stall.call.since))]);
	const due = found.filter((stall) => !known.some((notice) => isStallNoticeOf(notice, stall)));
	const procs = due.some(inBash) ? table() : undefined;
	const attempts = due.map((stall) => ({
		child: stall.child,
		kind: "stalled" as const,
		result: postNotice(root, selfId, stall.child, { kind: "stalled", life: lifeOf(stall.child), call: stall.call }, stalledText(stall, now, groupOf(stall, procs, now)), now, stall.call.since),
	}));
	return reported(known, attempts);
};

/**
 * One look after your children: one readdir of `sessions/`, reading every record (`full`) or only new
 * and outdated ones (`quick`). Deaths and stalls are reported into your own inbox, where their notices
 * are the evidence they were (by this run or an earlier one, live or not). Stalls are judged only on
 * records this look read: a watched child a quick look didn't reread may show a call that has ended
 * since. A post that fails isn't evidence, so the next full look retries. `table` lists the machine's
 * processes (ps), only for a stall about to be reported on a bash call.
 */
export const lookAfterChildren = (
	root: string,
	selfId: string,
	watch: ChildWatch,
	scope: Scope,
	now: number,
	awakeSince: number,
	probe: PidProbe = pidAlive,
	stalledAfterMs = STALLED_AFTER_MS,
	table: ProcessTable = psTable,
): Look => {
	const look = readSessions(root, scope === "full" ? () => true : filesToRead(watch, now, probe));
	const judged = watchChildren(childrenAfter(watch.watched, look, selfId), watch.notices, now, awakeSince, probe);
	const deaths = reportDeaths(root, selfId, judged, watch.notices, now, awakeSince, probe);
	const read = new Set(look.records.map((record) => record.id));
	const stalls = reportStalls(root, selfId, judged.watched.filter((child) => read.has(child.id)), deaths.notices, now, awakeSince, stalledAfterMs, table);
	return {
		watch: { files: look.files, watched: deaths.watched, notices: stalls.notices },
		records: look.records,
		posted: [...deaths.posted, ...stalls.posted],
		failed: [...deaths.failed, ...stalls.failed],
	};
};
