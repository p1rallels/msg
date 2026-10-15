import { deliver } from "./maildir.ts";
import { createMessage, type Delivery, type Message, type Sender } from "./message.ts";
import { directory, listPresence, type PidProbe, pidAlive, type Presence } from "./registry.ts";
import { resolveTarget, type Target } from "./resolve.ts";
import { fail, ok, type Result } from "./result.ts";

export interface Outgoing {
	readonly text: string;
	readonly delivery?: Delivery;
	readonly replyTo?: string;
	/** Epoch ms until which the sender blocks for a reply; tells the recipient it's being waited on. */
	readonly awaitingUntil?: number;
}

const isSelf = (query: string, self: Sender): boolean => {
	const normalized = query.trim().replace(/^@/, "").toLowerCase();
	return normalized === self.id.toLowerCase() || (self.name !== undefined && normalized === self.name.toLowerCase());
};

/** A headless run that's idle has finished its prompt and is about to exit: nobody will answer. */
export const canAnswer = (target: Target): boolean =>
	target.live && !((target.presence.mode === "print" || target.presence.mode === "json") && target.presence.activity === "idle");

/** Resolves `query` among every session but the sender's own. */
export const findRecipient = (root: string, self: Sender, query: string, now: number, probe: PidProbe = pidAlive): Result<Target> => {
	const others = listPresence(root).filter((record: Presence) => record.id !== self.id);
	const resolved = resolveTarget(query, directory(others, now, probe));
	if (resolved.ok || !isSelf(query, self)) return resolved;
	return fail(`"${query.trim()}" is you`);
};

/** Drops a message for `target` into its inbox. */
export const post = (root: string, from: Sender, target: Target, outgoing: Outgoing, now: number): Result<Message> => {
	const created = createMessage(
		{
			from,
			to: target.presence.id,
			text: outgoing.text,
			...(outgoing.delivery ? { delivery: outgoing.delivery } : {}),
			...(outgoing.replyTo ? { replyTo: outgoing.replyTo } : {}),
			...(outgoing.awaitingUntil !== undefined ? { awaitingUntil: outgoing.awaitingUntil } : {}),
		},
		now,
	);
	if (!created.ok) return created;
	deliver(root, created.value);
	return ok(created.value);
};
