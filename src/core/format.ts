import { ago, type Delivery } from "./message.ts";
import type { Directory, Presence } from "./registry.ts";
import type { Target } from "./resolve.ts";

export const tildify = (path: string, home: string): string =>
	home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

const uptime = (since: number, now: number): string => ago(since, now).replace(/ ago$/, "");

export const displayName = (presence: Pick<Presence, "name">): string => presence.name ?? "(unnamed)";

export const describeLive = (presence: Presence, now: number, home: string): string =>
	[displayName(presence), presence.id, presence.mode, presence.activity, tildify(presence.cwd, home), `up ${uptime(presence.startedAt, now)}`].join(" · ");

export const describeOffline = (presence: Presence, now: number, home: string): string =>
	[displayName(presence), presence.id, presence.mode, tildify(presence.cwd, home), `last seen ${ago(presence.endedAt ?? presence.heartbeatAt, now)}`].join(" · ");

export interface ListOptions {
	readonly all: boolean;
	readonly maxOffline: number;
}

export const formatDirectory = (dir: Directory, self: Presence | undefined, now: number, home: string, options: ListOptions): string => {
	const others = (records: readonly Presence[]) => records.filter((record) => record.id !== self?.id);
	const live = others(dir.live);
	const offline = others(dir.offline);
	const lines = [
		self ? `you: ${[displayName(self), self.id, self.mode, tildify(self.cwd, home)].join(" · ")}` : undefined,
		live.length > 0 ? `${live.length} live:` : "no other live sessions.",
		...live.map((record) => `- ${describeLive(record, now, home)}`),
		...(options.all && offline.length > 0
			? [`${offline.length} offline (they get messages when they resume):`, ...offline.slice(0, options.maxOffline).map((record) => `- ${describeOffline(record, now, home)}`)]
			: []),
		...(options.all && offline.length > options.maxOffline ? [`… and ${offline.length - options.maxOffline} more`] : []),
		...(!options.all && offline.length > 0 ? [`(${offline.length} offline not shown)`] : []),
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
};

/** When the recipient will see a message, from its presence record. */
export const expectation = (target: Target, delivery: Delivery, now: number): string => {
	const { presence, live } = target;
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

export const targetLabel = (target: Target): string => `${displayName(target.presence)} (${target.presence.id})`;
