import { resolve } from "node:path";
import { partyLabel } from "./message.ts";
import type { Directory, Presence } from "./registry.ts";
import { fail, ok, type Result } from "./result.ts";

export const MIN_PREFIX = 4;
export const PARENT = "parent";
export const CHILDREN = "children";

export interface Target {
	readonly id: string;
	/** Missing only for a parent that has never run msg: its inbox keeps the mail all the same. */
	readonly presence?: Presence;
	readonly live: boolean;
	readonly via: "id" | "parent" | "folder" | "name" | "prefix" | "children";
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

const describe = (records: readonly Presence[]): string => records.map((record) => `${partyLabel(record)} (${record.id})`).join(", ");

const sameName = (query: string) => (record: Presence) => record.name?.toLowerCase() === query.toLowerCase();

const unique = (matches: readonly Presence[], query: string, kind: string): Result<Presence> | undefined => {
	if (matches.length === 0) return undefined;
	const [only] = matches;
	if (matches.length === 1 && only) return ok(only);
	return fail(`${kind} "${query}" is ambiguous: ${describe(matches)}. Use the full session id.`);
};

const preferFamily = (matches: readonly Presence[], asker: Asker): readonly Presence[] => {
	const family = matches.filter((record) => record.id === asker.parent || record.parent === asker.id);
	return family.length > 0 ? family : matches;
};

const identity = (path: string): string => path;

/**
 * Finds the one session `query` names, never the asker (leave it out of `dir`). Order: exact id,
 * `parent`, a folder (the live session working there, else the last one seen there), a live name
 * (your parent and children first), a unique id prefix (≥4 chars), the most recently seen offline name.
 */
export const resolveTarget = (rawQuery: string, dir: Directory, asker: Asker, lookup: Lookup): Result<Target> => {
	const query = cleanQuery(rawQuery);
	if (!query) return fail("recipient is empty");
	const all = [...dir.live, ...dir.offline];
	const liveIds = new Set(dir.live.map((record) => record.id));
	const found = (presence: Presence, via: Target["via"]): Result<Target> => ok({ id: presence.id, presence, live: liveIds.has(presence.id), via });

	const exact = all.find((record) => record.id === query);
	if (exact) return found(exact, "id");

	if (query.toLowerCase() === PARENT || (asker.parent !== undefined && query === asker.parent)) {
		if (asker.parent === undefined) return fail("you have no parent session (no session's bash started you)");
		const record = all.find((candidate) => candidate.id === asker.parent);
		return record ? found(record, "parent") : ok({ id: asker.parent, live: false, via: "parent" });
	}

	if (query.toLowerCase() === CHILDREN) return fail(`"${CHILDREN}" names a group: msg_send fans out to every live child, msg_wait takes any child`);

	const folder = folderOf(query, asker.cwd ?? lookup.home, lookup.home);
	if (folder !== undefined) {
		const canonical = lookup.canonical ?? identity;
		const wanted = canonical(folder);
		const here = (record: Presence) => record.cwd !== "" && canonical(record.cwd) === wanted;
		const live = dir.live.filter(here);
		const [only] = live;
		if (live.length > 1) return fail(`${live.length} live sessions work in ${folder}: ${describe(live)}. Use a session id.`);
		if (only) return found(only, "folder");
		const last = dir.offline.find(here);
		return last ? found(last, "folder") : fail(`no session works in ${folder}`);
	}

	const liveName = unique(preferFamily(dir.live.filter(sameName(query)), asker), query, "name");
	if (liveName) return liveName.ok ? found(liveName.value, "name") : liveName;

	const prefixed = query.length >= MIN_PREFIX ? unique(all.filter((record) => record.id.startsWith(query)), query, "id prefix") : undefined;
	if (prefixed) return prefixed.ok ? found(prefixed.value, "prefix") : prefixed;

	const offlineName = dir.offline.find(sameName(query));
	if (offlineName) return found(offlineName, "name");

	const known = dir.live.length > 0 ? `live sessions: ${describe(dir.live)}` : "no live sessions right now";
	return fail(`no session matches "${query}" (${known})`);
};
