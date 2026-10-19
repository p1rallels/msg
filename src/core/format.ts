import { type Family, familyOf, hasFamily } from "./lineage.ts";
import { ago, type Delivery } from "./message.ts";
import type { Directory, Presence } from "./registry.ts";
import type { Target } from "./resolve.ts";

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

const childLines = (family: Family, dir: Directory, liveIds: ReadonlySet<string>, now: number, home: string, maxOffline: number): string[] => {
	const ids = new Set(family.children.map((child) => child.id));
	const live = dir.live.filter((record) => ids.has(record.id));
	const offline = dir.offline.filter((record) => ids.has(record.id));
	if (live.length + offline.length === 0) return ["no children."];
	return [
		`children: ${live.length + offline.length} (${live.length} live)`,
		...[...live, ...offline.slice(0, maxOffline)].map((record) => `- ${describeRecord(record, liveIds.has(record.id), now, home)}`),
		...(offline.length > maxOffline ? [`… and ${offline.length - maxOffline} older`] : []),
	];
};

/** You, your parent and your children: the default view of a session that has family. */
const formatFamily = (dir: Directory, self: Presence, family: Family, now: number, home: string, options: ListOptions): string => {
	const liveIds = new Set(dir.live.map((record) => record.id));
	const kin = new Set([self.id, ...(family.parentId ? [family.parentId] : []), ...family.children.map((child) => child.id)]);
	const others = dir.live.filter((record) => !kin.has(record.id)).length;
	const lines = [
		youLine(self, home),
		parentLine(family, liveIds, now, home),
		...childLines(family, dir, liveIds, now, home, options.maxOffline),
		others > 0 ? `(${others} other live session${others === 1 ? "" : "s"}: all: true lists everyone)` : undefined,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
};

const relationTag = (record: Presence, self: Presence | undefined): string => {
	if (self === undefined) return "";
	if (record.id === self.parent) return " (your parent)";
	return record.parent === self.id ? " (your child)" : "";
};

/** Everyone on the machine: live sessions, plus offline ones with `all`. */
const formatMachine = (dir: Directory, self: Presence | undefined, now: number, home: string, options: ListOptions): string => {
	const others = (records: readonly Presence[]) => records.filter((record) => record.id !== self?.id);
	const live = others(dir.live);
	const offline = others(dir.offline);
	const lines = [
		self ? youLine(self, home) : undefined,
		live.length > 0 ? `${live.length} live:` : "no other live sessions.",
		...live.map((record) => `- ${describeLive(record, now, home)}${relationTag(record, self)}`),
		...(options.all && offline.length > 0
			? [
					`${offline.length} offline (they get messages when they resume):`,
					...offline.slice(0, options.maxOffline).map((record) => `- ${describeOffline(record, now, home)}${relationTag(record, self)}`),
				]
			: []),
		...(options.all && offline.length > options.maxOffline ? [`… and ${offline.length - options.maxOffline} more`] : []),
		...(!options.all && offline.length > 0 ? [`(${offline.length} offline not shown)`] : []),
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
};

/** Family first: you, your parent and your children; `all`, or having no family, lists the whole machine. */
export const formatDirectory = (dir: Directory, self: Presence | undefined, now: number, home: string, options: ListOptions): string => {
	const family = self ? familyOf([...dir.live, ...dir.offline], self) : undefined;
	if (!options.all && self && family && hasFamily(family)) return formatFamily(dir, self, family, now, home, options);
	return formatMachine(dir, self, now, home, options);
};

/** When the recipient will see a message, from its presence record. */
export const expectation = (target: Target, delivery: Delivery, now: number): string => {
	const { presence, live } = target;
	if (presence === undefined) return "it has never run msg (no presence record); the message waits in its inbox";
	if (!live) {
		if (presence.mode === "cli") return `a msg CLI identity, last seen ${ago(presence.heartbeatAt, now)}; it reads this with \`msg inbox\``;
		return `offline (last seen ${ago(presence.endedAt ?? presence.heartbeatAt, now)}); it gets the message when the session resumes`;
	}
	if (presence.mode === "cli") return "waiting on the msg CLI; it gets the message right away";
	if (presence.activity === "busy") {
		return delivery === "steer" ? "busy; it sees the message at its next step" : "busy; it sees the message when its current task is done";
	}
	if (presence.mode === "print" || presence.mode === "json") return "idle pi -p run that is about to exit; it may never read this";
	return "idle; it wakes up to handle the message";
};

export const targetLabel = (target: Target): string => {
	if (target.presence) return `${displayName(target.presence)} (${target.id})`;
	return `${target.via === "parent" ? "your parent" : "(unknown)"} (${target.id})`;
};
