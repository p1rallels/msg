import { homedir } from "node:os";
import { childrenOf } from "./lineage.ts";
import { deliver } from "./maildir.ts";
import { createMessage, type Delivery, type Kind, type Life, type Message, type Sender } from "./message.ts";
import { canonicalPath } from "./paths.ts";
import { directory, listPresence, type PidProbe, pidAlive, type Presence } from "./registry.ts";
import { type Asker, cleanQuery, folderOf, type Lookup, resolveTarget, type Target } from "./resolve.ts";
import { fail, ok, type Result } from "./result.ts";

export interface Outgoing {
	readonly text: string;
	readonly delivery?: Delivery;
	readonly replyTo?: string;
	/** Epoch ms until which the sender blocks for a reply; tells the recipient it's being waited on. */
	readonly awaitingUntil?: number;
	readonly byUser?: boolean;
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

/** Resolves `query` among every session but the asker's own. */
export const findRecipient = (root: string, self: Asker, query: string, now: number, probe: PidProbe = pidAlive, lookup: Lookup = machineLookup()): Result<Target> => {
	const others = listPresence(root).filter((record) => record.id !== self.id);
	const resolved = resolveTarget(query, directory(others, now, probe), self, lookup);
	if (resolved.ok || !isSelf(query, self, lookup)) return resolved;
	return fail(`"${query.trim()}" is you`);
};

/** The recipients of a fan-out to `children`: every live child, by name. */
export const liveChildren = (root: string, selfId: string, now: number, probe: PidProbe = pidAlive): Target[] =>
	directory(childrenOf(listPresence(root), selfId), now, probe).live.map((presence) => ({ id: presence.id, presence, live: true, via: "children" }));

/** Drops a message for `target` into its inbox. */
export const post = (root: string, from: Sender, target: Target, outgoing: Outgoing, now: number): Result<Message> => {
	const created = createMessage(
		{
			from,
			to: target.id,
			text: outgoing.text,
			...(outgoing.delivery ? { delivery: outgoing.delivery } : {}),
			...(outgoing.replyTo ? { replyTo: outgoing.replyTo } : {}),
			...(outgoing.awaitingUntil !== undefined ? { awaitingUntil: outgoing.awaitingUntil } : {}),
			...(outgoing.byUser ? { byUser: true } : {}),
		},
		now,
	);
	if (!created.ok) return created;
	deliver(root, created.value);
	return ok(created.value);
};

/**
 * Drops an exit notice: `ended` goes from a child to its parent, `died` into the parent's own inbox
 * `from` the child, naming the `life` that died.
 */
export const postExit = (root: string, from: Sender, to: string, kind: Kind, text: string, now: number, life?: Life): Result<Message> => {
	const created = createMessage({ from, to, text, kind, ...(life ? { life } : {}) }, now);
	if (!created.ok) return created;
	deliver(root, created.value);
	return ok(created.value);
};
