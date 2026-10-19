import { type Family, familyOf, hasFamily } from "./lineage.ts";
import { ago, type Message, partyLabel } from "./message.ts";
import type { Directory, Presence } from "./registry.ts";
import type { Target } from "./resolve.ts";
import type { WaitOutcome } from "./waiters.ts";

export const tildify = (path: string, home: string): string =>
	home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

const uptime = (since: number, now: number): string => ago(since, now).replace(/ ago$/, "");

export const displayName = (presence: Pick<Presence, "name">): string => presence.name ?? "(unnamed)";

/** busy or idle while live; ended, or offline when it stopped heartbeating without ending. */
export const stateOf = (presence: Presence, live: boolean): string => {
	if (live) return presence.activity;
	return presence.endedAt === undefined ? "offline" : "ended";
};

const when = (presence: Presence, live: boolean, now: number): string => {
	if (live) return `up ${uptime(presence.startedAt, now)}`;
	return presence.endedAt === undefined ? `last seen ${ago(presence.heartbeatAt, now)}` : ago(presence.endedAt, now);
};

/** `name · id · mode · busy/idle/ended/offline · cwd · up 5m / 3m ago` */
export const describeRecord = (presence: Presence, live: boolean, now: number, home: string): string =>
	[displayName(presence), presence.id, presence.mode, stateOf(presence, live), tildify(presence.cwd, home), when(presence, live, now)].join(" · ");

export const describeLive = (presence: Presence, now: number, home: string): string => describeRecord(presence, true, now, home);

export const describeOffline = (presence: Presence, now: number, home: string): string => describeRecord(presence, false, now, home);

export interface ListOptions {
	readonly all: boolean;
	readonly maxOffline: number;
}

const youLine = (self: Presence, home: string): string => `you: ${[displayName(self), self.id, self.mode, tildify(self.cwd, home)].join(" · ")}`;

const parentLine = (family: Family, liveIds: ReadonlySet<string>, now: number, home: string): string | undefined => {
	if (family.parentId === undefined) return undefined;
	if (family.parent === undefined) return `parent: ${family.parentId} (never ran msg: no presence record; mail waits in its inbox)`;
	return `parent: ${describeRecord(family.parent, liveIds.has(family.parent.id), now, home)}`;
};

const subLines = (family: Family, dir: Directory, liveIds: ReadonlySet<string>, now: number, home: string, maxOffline: number): string[] => {
	const ids = new Set(family.children.map((child) => child.id));
	const live = dir.live.filter((record) => ids.has(record.id));
	const offline = dir.offline.filter((record) => ids.has(record.id));
	if (live.length + offline.length === 0) return ["no subs."];
	return [
		`subs: ${live.length + offline.length} (${live.length} live; to: "children" messages the live ones)`,
		...[...live, ...offline.slice(0, maxOffline)].map((record) => `- ${describeRecord(record, liveIds.has(record.id), now, home)}`),
		...(offline.length > maxOffline ? [`… and ${offline.length - maxOffline} older`] : []),
	];
};

/** A sub sees itself and its parent, the only session it can message. */
const formatSub = (dir: Directory, self: Presence, family: Family, now: number, home: string): string => {
	const liveIds = new Set(dir.live.map((record) => record.id));
	const lines = [youLine(self, home), parentLine(family, liveIds, now, home), `you're a sub: msg_send reaches only your parent (to: "parent").`];
	return lines.filter((line): line is string => line !== undefined).join("\n");
};

/** A parent sees itself and its subs. */
const formatParent = (dir: Directory, self: Presence, family: Family, now: number, home: string, options: ListOptions): string => {
	const liveIds = new Set(dir.live.map((record) => record.id));
	const kin = new Set([self.id, ...family.children.map((child) => child.id)]);
	const others = dir.live.filter((record) => !kin.has(record.id)).length;
	return [
		youLine(self, home),
		...subLines(family, dir, liveIds, now, home, options.maxOffline),
		...(others > 0 ? [`(${others} other live session${others === 1 ? "" : "s"}: all: true lists everyone)`] : []),
	].join("\n");
};

/** How `record` stands to `self`: your parent, your sub, someone else's sub (reached only through its parent). */
const relationTag = (record: Presence, self: Presence | undefined, records: readonly Presence[]): string => {
	if (self !== undefined && record.id === self.parent) return " (your parent)";
	if (record.parent === undefined) return "";
	if (self !== undefined && record.parent === self.id) return " (your sub)";
	const parent = records.find((candidate) => candidate.id === record.parent) ?? { id: record.parent };
	return ` (${partyLabel(parent)}'s sub)`;
};

/** Everyone on the machine: live sessions, plus offline ones with `all`. */
const formatMachine = (dir: Directory, self: Presence | undefined, now: number, home: string, options: ListOptions): string => {
	const records = [...dir.live, ...dir.offline];
	const others = (list: readonly Presence[]) => list.filter((record) => record.id !== self?.id);
	const live = others(dir.live);
	const offline = others(dir.offline);
	const lines = [
		self ? youLine(self, home) : undefined,
		live.length > 0 ? `${live.length} live:` : "no other live sessions.",
		...live.map((record) => `- ${describeLive(record, now, home)}${relationTag(record, self, records)}`),
		...(options.all && offline.length > 0
			? [
					`${offline.length} offline (they get messages when they resume):`,
					...offline.slice(0, options.maxOffline).map((record) => `- ${describeOffline(record, now, home)}${relationTag(record, self, records)}`),
				]
			: []),
		...(options.all && offline.length > options.maxOffline ? [`… and ${offline.length - options.maxOffline} more`] : []),
		...(!options.all && offline.length > 0 ? [`(${offline.length} offline not shown)`] : []),
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
};

/**
 * What a session sees of the others. A sub: itself and its parent, whatever `all` says. A parent: itself and its
 * subs. Anyone else, or a parent with `all`: the whole machine, someone else's subs marked as such.
 */
export const formatDirectory = (dir: Directory, self: Presence | undefined, now: number, home: string, options: ListOptions): string => {
	const family = self ? familyOf([...dir.live, ...dir.offline], self) : undefined;
	if (self && family && family.parentId !== undefined) return formatSub(dir, self, family, now, home);
	if (!options.all && self && family && hasFamily(family)) return formatParent(dir, self, family, now, home, options);
	return formatMachine(dir, self, now, home, options);
};

/** When the recipient will see a message, from its presence record. */
export const expectation = (target: Target, now: number): string => {
	const { presence, live } = target;
	if (presence === undefined) return "it has never run msg (no presence record); the message waits in its inbox";
	if (!live) return `offline (last seen ${ago(presence.endedAt ?? presence.heartbeatAt, now)}); it gets the message when the session resumes`;
	if (presence.activity === "busy") return "busy; it sees the message at its next step";
	if (presence.mode === "print" || presence.mode === "json") return "idle pi -p run that is about to exit; it may never read this";
	return "idle; it wakes up to handle the message";
};

export const targetLabel = (target: Target): string => {
	if (target.presence) return `${displayName(target.presence)} (${target.id})`;
	return `${target.via === "parent" ? "your parent" : "(unknown)"} (${target.id})`;
};

/** What msg_send returns after waiting on `who`: its reply, its report or death instead, or nothing in time. */
export const replyText = (outcome: WaitOutcome, who: string, seconds: number): string => {
	switch (outcome.kind) {
		case "message": {
			const { message } = outcome;
			if (message.kind === "ended" && message.stopped) {
				return `${who} was stopped before it finished, without replying. Its last message, not a finished report (inspect its work before relying on it):\n${message.text}`;
			}
			if (message.kind === "ended") return `${who} ended before replying. Its final message:\n${message.text}`;
			if (message.kind === "died") return `${who} died before replying: ${message.text}`;
			return `${who} replied (${message.id}):\n${message.text}`;
		}
		case "timeout":
			return `No reply from ${who} within ${seconds}s. A later reply arrives as a normal message.`;
		case "aborted":
			return `Stopped waiting for ${who}. A later reply arrives as a normal message.`;
	}
};

/** The first line of a message as the TUI shows it. */
export const headline = (message: Message): string => {
	const who = partyLabel(message.from);
	if (message.kind === "ended") return message.stopped ? `✉ ${who} was stopped before it finished` : `✉ ${who} ended`;
	if (message.kind === "died") return `✉ ${who} died`;
	return `✉ ${who}`;
};
