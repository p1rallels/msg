import type { Message } from "./message.ts";

export type WaitOutcome =
	| { readonly kind: "message"; readonly message: Message }
	| { readonly kind: "timeout" }
	| { readonly kind: "aborted" };

export type MessageMatch = (message: Message) => boolean;

export interface Waiters {
	/** Resolves with the first offered message `match` accepts, or on timeout / abort. Never rejects. */
	readonly wait: (match: MessageMatch, timeoutMs: number, signal?: AbortSignal) => Promise<WaitOutcome>;
	/** Hands `message` to the oldest waiter that wants it. True when one took it. */
	readonly offer: (message: Message) => boolean;
	readonly size: () => number;
	/** Settles every pending wait as aborted, e.g. when the session goes away. */
	readonly cancelAll: () => void;
}

interface Entry {
	readonly match: MessageMatch;
	readonly settle: (outcome: WaitOutcome) => void;
}

export const createWaiters = (): Waiters => {
	const entries: Entry[] = [];

	const remove = (entry: Entry): void => {
		const index = entries.indexOf(entry);
		if (index >= 0) entries.splice(index, 1);
	};

	const wait: Waiters["wait"] = (match, timeoutMs, signal) =>
		new Promise<WaitOutcome>((resolve) => {
			if (signal?.aborted) return resolve({ kind: "aborted" });
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => entry.settle({ kind: "aborted" });
			const entry: Entry = {
				match,
				settle: (outcome) => {
					remove(entry);
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve(outcome);
				},
			};
			entries.push(entry);
			timer = setTimeout(() => entry.settle({ kind: "timeout" }), Math.max(0, timeoutMs));
			signal?.addEventListener("abort", onAbort, { once: true });
		});

	const offer: Waiters["offer"] = (message) => {
		const taker = entries.find((entry) => entry.match(message));
		if (!taker) return false;
		taker.settle({ kind: "message", message });
		return true;
	};

	const cancelAll = (): void => {
		for (const entry of [...entries]) entry.settle({ kind: "aborted" });
	};

	return { wait, offer, size: () => entries.length, cancelAll };
};

/** A reply to `sent`: from its recipient, and either pointing at it or not pointing anywhere. Its `ended`, `died` or `stalled` too. */
export const isReplyTo =
	(sent: Pick<Message, "id" | "to">): MessageMatch =>
	(message) =>
		message.from.id === sent.to && (message.replyTo === undefined || message.replyTo === sent.id);
