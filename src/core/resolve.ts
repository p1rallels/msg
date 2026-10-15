import { partyLabel } from "./message.ts";
import type { Directory, Presence } from "./registry.ts";
import { fail, ok, type Result } from "./result.ts";

export const MIN_PREFIX = 4;

export interface Target {
	readonly presence: Presence;
	readonly live: boolean;
	readonly via: "id" | "name" | "prefix";
}

const describe = (records: readonly Presence[]): string =>
	records.map((record) => `${partyLabel(record)} (${record.id})`).join(", ");

const sameName = (query: string) => (record: Presence) => record.name?.toLowerCase() === query.toLowerCase();

const unique = (matches: readonly Presence[], query: string, kind: string): Result<Presence> | undefined => {
	if (matches.length === 0) return undefined;
	const [only] = matches;
	if (matches.length === 1 && only) return ok(only);
	return fail(`${kind} "${query}" is ambiguous: ${describe(matches)}. Use the full session id.`);
};

const target = (presence: Presence, live: boolean, via: Target["via"]): Result<Target> => ok({ presence, live, via });

/**
 * Finds the session `query` names. Order: exact id, live name, unique id prefix (≥4 chars),
 * then the most recently seen offline session with that name.
 */
export const resolveTarget = (rawQuery: string, dir: Directory): Result<Target> => {
	const query = rawQuery.trim().replace(/^@/, "");
	if (!query) return fail("recipient is empty");
	const all = [...dir.live, ...dir.offline];
	const isLiveRecord = (record: Presence) => dir.live.some((live) => live.id === record.id);

	const exact = all.find((record) => record.id === query);
	if (exact) return target(exact, isLiveRecord(exact), "id");

	const liveName = unique(dir.live.filter(sameName(query)), query, "name");
	if (liveName) return liveName.ok ? target(liveName.value, true, "name") : liveName;

	const prefixed = query.length >= MIN_PREFIX ? unique(all.filter((record) => record.id.startsWith(query)), query, "id prefix") : undefined;
	if (prefixed) return prefixed.ok ? target(prefixed.value, isLiveRecord(prefixed.value), "prefix") : prefixed;

	const offlineName = dir.offline.find(sameName(query));
	if (offlineName) return target(offlineName, false, "name");

	const known = dir.live.length > 0 ? `live sessions: ${describe(dir.live)}` : "no live sessions right now";
	return fail(`no session matches "${query}" (${known}). msg_list shows who's around.`);
};
