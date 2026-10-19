import { homedir } from "node:os";
import { childrenOf } from "./lineage.ts";
import { deliver } from "./maildir.ts";
import { createMessage, exactLabel, type Life, type Message, partyLabel, type Sender } from "./message.ts";
import { canonicalPath } from "./paths.ts";
import { type Directory, directory, listPresence, type PidProbe, pidAlive, type Presence } from "./registry.ts";
import { type Asker, cleanQuery, folderOf, isChildren, type Lookup, resolveTarget, type Target } from "./resolve.ts";
import { fail, ok, type Result } from "./result.ts";

export interface Outgoing {
	readonly text: string;
	readonly replyTo?: string;
	/** Epoch ms until which the sender blocks for a reply; tells the recipient it's being waited on. */
	readonly awaitingUntil?: number;
}

export const machineLookup = (): Lookup => ({ home: homedir(), canonical: canonicalPath });

/** A session as the sender of a message: its id, name and folder. */
export const senderOf = (presence: Presence): Sender => ({ id: presence.id, ...(presence.name ? { name: presence.name } : {}), cwd: presence.cwd });

const isSelf = (query: string, self: Asker, lookup: Lookup): boolean => {
	const cleaned = cleanQuery(query);
	const lowered = cleaned.toLowerCase();
	if (lowered === self.id.toLowerCase() || (self.name !== undefined && lowered === self.name.toLowerCase())) return true;
	const folder = folderOf(cleaned, self.cwd ?? lookup.home, lookup.home);
	if (folder === undefined || self.cwd === undefined) return false;
	const canonical = lookup.canonical ?? ((path: string) => path);
	return canonical(folder) === canonical(self.cwd);
};

/** A headless run that's idle has finished its prompt and is about to exit: nobody will answer. */
export const canAnswer = (target: Target): boolean => {
	const { presence } = target;
	if (!target.live || presence === undefined) return false;
	return !((presence.mode === "print" || presence.mode === "json") && presence.activity === "idle");
};

const recordOf = (dir: Directory, id: string): Presence | undefined => [...dir.live, ...dir.offline].find((record) => record.id === id);

/** A sub talks to its parent and nobody else. */
const onlyParent = (parentLabel: string): string => `you're ${parentLabel}'s sub: you can message only your parent (to: "parent")`;

/** Only a sub's parent may message it. */
const walledOff = (sub: Presence, parent: Presence | { readonly id: string }): string =>
	`${exactLabel(sub)} is ${partyLabel(parent)}'s sub: message ${exactLabel(parent)}`;

/** A parent's group: every live sub, by name. */
const subsOf = (dir: Directory, selfId: string): Target[] =>
	childrenOf(dir.live, selfId).map((presence) => ({ id: presence.id, presence, live: true, via: "children" }));

/**
 * Who `query` reaches from `self`, among `records` (the asker's own included or not). The tree is a wall: a sub
 * reaches only its parent, a sub is reached only by its parent, and `children` is a parent's live subs. Anyone
 * else resolves strictly (resolveTarget). Errors are one line, saying what to do instead.
 */
export const recipients = (
	query: string,
	records: readonly Presence[],
	self: Asker,
	now: number,
	probe: PidProbe = pidAlive,
	lookup: Lookup = machineLookup(),
): Result<Target[]> => {
	const dir = directory(
		records.filter((record) => record.id !== self.id),
		now,
		probe,
	);
	if (self.parent !== undefined) {
		const parent = self.parent;
		const resolved = isChildren(query) ? undefined : resolveTarget(query, dir, self, lookup, now);
		if (resolved?.ok && resolved.value.id === parent) return ok([resolved.value]);
		return fail(onlyParent(partyLabel(recordOf(dir, parent) ?? { id: parent })));
	}
	if (isChildren(query)) {
		const subs = subsOf(dir, self.id);
		return subs.length > 0 ? ok(subs) : fail("you have no live subs (msg_list shows them)");
	}
	const resolved = resolveTarget(query, dir, self, lookup, now);
	if (!resolved.ok) return isSelf(query, self, lookup) ? fail(`"${query.trim()}" is you`) : resolved;
	const target = resolved.value;
	const parentId = target.presence?.parent;
	if (target.presence === undefined || parentId === undefined || parentId === self.id) return ok([target]);
	return fail(walledOff(target.presence, recordOf(dir, parentId) ?? { id: parentId }));
};

/** recipients() over the store's records. */
export const findRecipients = (root: string, self: Asker, query: string, now: number, probe: PidProbe = pidAlive, lookup: Lookup = machineLookup()): Result<Target[]> =>
	recipients(query, listPresence(root), self, now, probe, lookup);

/** Drops a message for `target` into its inbox. */
export const post = (root: string, from: Sender, target: Target, outgoing: Outgoing, now: number): Result<Message> => {
	const created = createMessage(
		{
			from,
			to: target.id,
			text: outgoing.text,
			...(outgoing.replyTo ? { replyTo: outgoing.replyTo } : {}),
			...(outgoing.awaitingUntil !== undefined ? { awaitingUntil: outgoing.awaitingUntil } : {}),
		},
		now,
	);
	if (!created.ok) return created;
	deliver(root, created.value);
	return ok(created.value);
};

/** An exit notice: `ended` (stopped or not) from a sub to its parent, `died` naming the life that died. */
export type Exit = { readonly kind: "ended"; readonly stopped: boolean } | { readonly kind: "died"; readonly life: Life };

/** Drops an exit notice: `ended` goes from a sub to its parent, `died` into the parent's own inbox `from` the sub. */
export const postExit = (root: string, from: Sender, to: string, exit: Exit, text: string, now: number): Result<Message> => {
	const created = createMessage({ from, to, text, ...exit }, now);
	if (!created.ok) return created;
	deliver(root, created.value);
	return ok(created.value);
};
