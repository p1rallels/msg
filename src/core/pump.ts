import { claim, pending, unclaim } from "./maildir.ts";
import type { Message } from "./message.ts";

export interface PumpHooks {
	/** False leaves everything in the inbox for a later pump. Asked before each claim. */
	readonly accepting: () => boolean;
	/** A waiting tool call gets first pick. True when one took the message. */
	readonly offer: (message: Message) => boolean;
	/** Puts the message into the session. Throws when the session is gone; the message goes back. */
	readonly deliver: (message: Message) => void;
}

export interface PumpReport {
	readonly delivered: readonly Message[];
	readonly offered: readonly Message[];
	readonly invalid: readonly { readonly file: string; readonly error: string }[];
	readonly failure?: unknown;
}

/** Drains `id`'s inbox oldest first. Synchronous, so two pumps in one process never interleave. */
export const pumpOnce = (root: string, id: string, hooks: PumpHooks): PumpReport => {
	const delivered: Message[] = [];
	const offered: Message[] = [];
	const invalid: { file: string; error: string }[] = [];
	for (const file of pending(root, id)) {
		if (!hooks.accepting()) break;
		const claimed = claim(root, id, file);
		if (!claimed) continue;
		if (claimed.kind === "invalid") {
			invalid.push({ file, error: claimed.error });
			continue;
		}
		if (hooks.offer(claimed.message)) {
			offered.push(claimed.message);
			continue;
		}
		try {
			hooks.deliver(claimed.message);
			delivered.push(claimed.message);
		} catch (failure) {
			unclaim(root, id, file);
			return { delivered, offered, invalid, failure };
		}
	}
	return { delivered, offered, invalid };
};
