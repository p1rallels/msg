import { rmSync } from "node:fs";
import { join } from "node:path";
import { listJsonFiles, parseJson, readTextOrUndefined, writeFileAtomic } from "./fsx.ts";
import { normalizeName } from "./message.ts";
import { isValidId, presencePath, recordFile, sessionsDir } from "./paths.ts";
import { fail, ok, type Result } from "./result.ts";

export const PRESENCE_VERSION = 1;
/** A record whose heartbeat is older than this is offline, whatever it claims. */
export const STALE_AFTER_MS = 45_000;
export const HEARTBEAT_EVERY_MS = 10_000;

/** How the session runs: pi's own modes, `web` for pi-web; `cli` only in old records the msg CLI wrote before it was cut. */
export type Mode = "tui" | "rpc" | "json" | "print" | "web" | "cli";
export type Activity = "idle" | "busy";

export interface Presence {
	readonly v: typeof PRESENCE_VERSION;
	readonly id: string;
	readonly name?: string;
	/** The session whose bash started this one (lineage). Its children are the records naming it here. */
	readonly parent?: string;
	readonly cwd: string;
	readonly pid: number;
	readonly mode: Mode;
	readonly activity: Activity;
	readonly startedAt: number;
	readonly heartbeatAt: number;
	readonly endedAt?: number;
}

const MODES: readonly Mode[] = ["tui", "rpc", "json", "print", "web", "cli"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const parsePresence = (value: unknown): Result<Presence> => {
	if (!isRecord(value)) return fail("expected an object");
	if (value.v !== PRESENCE_VERSION) return fail(`unsupported version ${JSON.stringify(value.v)}`);
	const id = typeof value.id === "string" ? value.id : "";
	if (!isValidId(id)) return fail("id: invalid");
	const cwd = typeof value.cwd === "string" ? value.cwd : "";
	const pid = finite(value.pid);
	const startedAt = finite(value.startedAt);
	const heartbeatAt = finite(value.heartbeatAt);
	if (pid === undefined || startedAt === undefined || heartbeatAt === undefined) return fail("pid/startedAt/heartbeatAt: expected numbers");
	const mode = MODES.find((candidate) => candidate === value.mode) ?? "rpc";
	const activity: Activity = value.activity === "busy" ? "busy" : "idle";
	const name = normalizeName(typeof value.name === "string" ? value.name : undefined);
	const parent = typeof value.parent === "string" && isValidId(value.parent) && value.parent !== id ? value.parent : undefined;
	const endedAt = finite(value.endedAt);
	return ok({
		v: PRESENCE_VERSION,
		id,
		...(name ? { name } : {}),
		...(parent ? { parent } : {}),
		cwd,
		pid,
		mode,
		activity,
		startedAt,
		heartbeatAt,
		...(endedAt !== undefined ? { endedAt } : {}),
	});
};

export const writePresence = (root: string, presence: Presence): void =>
	writeFileAtomic(presencePath(root, presence.id), `${JSON.stringify(presence)}\n`);

const readRecordFile = (root: string, file: string): Presence | undefined => {
	const raw = readTextOrUndefined(join(sessionsDir(root), file));
	if (raw === undefined) return undefined;
	const parsed = parsePresence(parseJson(raw));
	return parsed.ok ? parsed.value : undefined;
};

export const readPresence = (root: string, id: string): Presence | undefined => (isValidId(id) ? readRecordFile(root, recordFile(id)) : undefined);

export interface Sessions {
	/** Every record file in `sessions/`, read or not. */
	readonly files: ReadonlySet<string>;
	/** The records of the files that were read. A file that vanished or doesn't parse has none. */
	readonly records: readonly Presence[];
}

/** One readdir of `sessions/`, reading only the record files `wanted` picks. */
export const readSessions = (root: string, wanted: (file: string) => boolean): Sessions => {
	const files = listJsonFiles(sessionsDir(root));
	return { files: new Set(files), records: files.filter(wanted).flatMap((file) => readRecordFile(root, file) ?? []) };
};

export const listPresence = (root: string): Presence[] => [...readSessions(root, () => true).records];

export type PidProbe = (pid: number) => boolean;

/** `kill(pid, 0)` checks existence without signalling. EPERM still means the process exists. */
export const pidAlive: PidProbe = (pid) => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
};

export const isLive = (presence: Presence, now: number, probe: PidProbe = pidAlive, staleAfterMs = STALE_AFTER_MS): boolean =>
	presence.endedAt === undefined && now - presence.heartbeatAt <= staleAfterMs && probe(presence.pid);

export const lastSeen = (presence: Presence): number => presence.endedAt ?? presence.heartbeatAt;

export interface Directory {
	readonly live: readonly Presence[];
	readonly offline: readonly Presence[];
}

const byName = (a: Presence, b: Presence): number =>
	(a.name ?? "\uffff").localeCompare(b.name ?? "\uffff") || a.startedAt - b.startedAt;

/** Splits records into live (sorted by name) and offline (most recently seen first). */
export const directory = (records: readonly Presence[], now: number, probe: PidProbe = pidAlive): Directory => {
	const live = records.filter((record) => isLive(record, now, probe));
	const liveIds = new Set(live.map((record) => record.id));
	const offline = records.filter((record) => !liveIds.has(record.id)).sort((a, b) => lastSeen(b) - lastSeen(a));
	return { live: [...live].sort(byName), offline };
};

/** Forgets records nobody has seen for `maxAgeMs`. Their mailboxes stay. */
export const pruneOffline = (root: string, now: number, maxAgeMs: number, probe: PidProbe = pidAlive): number => {
	const stale = listPresence(root).filter((record) => !isLive(record, now, probe) && now - lastSeen(record) > maxAgeMs);
	for (const record of stale) rmSync(presencePath(root, record.id), { force: true });
	return stale.length;
};
