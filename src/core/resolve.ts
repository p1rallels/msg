import { resolve } from "node:path";
import { ago, exactLabel } from "./message.ts";
import type { Directory, Presence } from "./registry.ts";
import { fail, ok, type Result } from "./result.ts";

export const PARENT = "parent";
export const CHILDREN = "children";
/** A query this long that names nothing makes the sessions whose id starts with it likely. */
export const MIN_PREFIX = 4;
/** How many likely sessions an error names. */
export const LIKELY_LISTED = 3;

export interface Target {
	readonly id: string;
	/** Missing only for a parent that has never run msg: its inbox keeps the mail all the same. */
	readonly presence?: Presence;
	readonly live: boolean;
	readonly via: "id" | "parent" | "folder" | "name" | "children";
}

/** Who's asking: `parent`, `./x` and family-first names mean different sessions to different askers. */
export interface Asker {
	readonly id: string;
	readonly name?: string;
	readonly parent?: string;
	readonly cwd?: string;
}

export interface Lookup {
	readonly home: string;
	/** Maps a folder to one spelling (symlinks resolved), so `/tmp/x` finds a session in `/private/tmp/x`. */
	readonly canonical?: (path: string) => string;
}

export const cleanQuery = (raw: string): string => raw.trim().replace(/^@/, "");

export const isChildren = (raw: string): boolean => cleanQuery(raw).toLowerCase() === CHILDREN;

const FOLDER = /^(?:\/|~(?:\/|$)|\.{1,2}(?:\/|$))/;

/** `/x`, `~/x`, `./x`, `../x`, `~`, `.` and `..` name a folder, made absolute against `cwd`. */
export const folderOf = (query: string, cwd: string, home: string): string | undefined => {
	if (!FOLDER.test(query)) return undefined;
	if (query === "~" || query.startsWith("~/")) return resolve(home, query.slice(2));
	return resolve(cwd, query);
};

const describe = (records: readonly Presence[]): string => records.map(exactLabel).join(", ");

const sameName = (query: string) => (record: Presence) => record.name?.toLowerCase() === query.toLowerCase();

const unique = (matches: readonly Presence[], query: string): Result<Presence> | undefined => {
	if (matches.length === 0) return undefined;
	const [only] = matches;
	if (matches.length === 1 && only) return ok(only);
	return fail(`name "${query}" is ambiguous: ${describe(matches)}. Use the exact session id.`);
};

const preferFamily = (matches: readonly Presence[], asker: Asker): readonly Presence[] => {
	const family = matches.filter((record) => record.id === asker.parent || record.parent === asker.id);
	return family.length > 0 ? family : matches;
};

const identity = (path: string): string => path;

const seen = (record: Presence, live: boolean, now: number): string => {
	if (live) return "live now";
	return record.endedAt === undefined ? `last seen ${ago(record.heartbeatAt, now)}` : `ended ${ago(record.endedAt, now)}`;
};

/**
 * Finds the one session `query` names, never the asker (leave it out of `dir`), and never by a guess: an exact id
 * (live or offline), `parent`, a folder with exactly one live session, or a live name (your parent and children
 * first). When nothing live matches a folder or a name, the error names the likely sessions with their exact ids
 * and when each was last seen, so messaging one of them is a deliberate second step.
 */
export const resolveTarget = (rawQuery: string, dir: Directory, asker: Asker, lookup: Lookup, now: number): Result<Target> => {
	const query = cleanQuery(rawQuery);
	if (!query) return fail("recipient is empty");
	const all = [...dir.live, ...dir.offline];
	const liveIds = new Set(dir.live.map((record) => record.id));
	const found = (presence: Presence, via: Target["via"]): Result<Target> => ok({ id: presence.id, presence, live: liveIds.has(presence.id), via });
	const likely = (records: readonly Presence[]): string =>
		records
			.slice(0, LIKELY_LISTED)
			.map((record) => `${exactLabel(record)}, ${seen(record, liveIds.has(record.id), now)}`)
			.join("; ");

	const exact = all.find((record) => record.id === query);
	if (exact) return found(exact, "id");

	if (query.toLowerCase() === PARENT || (asker.parent !== undefined && query === asker.parent)) {
		if (asker.parent === undefined) return fail("you have no parent session (no session's bash started you)");
		const record = all.find((candidate) => candidate.id === asker.parent);
		return record ? found(record, "parent") : ok({ id: asker.parent, live: false, via: "parent" });
	}

	if (query.toLowerCase() === CHILDREN) return fail(`"${CHILDREN}" names a group, not one session`);

	const folder = folderOf(query, asker.cwd ?? lookup.home, lookup.home);
	if (folder !== undefined) {
		const canonical = lookup.canonical ?? identity;
		const wanted = canonical(folder);
		const here = (record: Presence) => record.cwd !== "" && canonical(record.cwd) === wanted;
		const live = dir.live.filter(here);
		const [only] = live;
		if (live.length > 1) return fail(`${live.length} live sessions work in ${folder}: ${describe(live)}. Use the exact session id.`);
		if (only) return found(only, "folder");
		const before = dir.offline.filter(here);
		if (before.length === 0) return fail(`no session works in ${folder}`);
		return fail(`nobody live works in ${folder}. Last there: ${likely(before)}. To message one of them anyway, use its exact id.`);
	}

	const named = unique(preferFamily(dir.live.filter(sameName(query)), asker), query);
	if (named) return named.ok ? found(named.value, "name") : named;

	const candidates = all.filter((record) => sameName(query)(record) || (query.length >= MIN_PREFIX && record.id.startsWith(query)));
	if (candidates.length > 0) return fail(`"${query}" is no live session's name and no session's exact id. Likely: ${likely(candidates)}. To message one of them, use its exact id.`);
	const known = dir.live.length > 0 ? `live sessions: ${describe(dir.live)}` : "no live sessions right now";
	return fail(`no session matches "${query}" (${known})`);
};
