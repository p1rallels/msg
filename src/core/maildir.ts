import { statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, isMissing, listJsonFiles, moveIfPresent, parseJson, readTextOrUndefined, writeFileAtomic } from "./fsx.ts";
import { timeOfMessageId } from "./ids.ts";
import { type Message, parseMessage } from "./message.ts";
import { type MailboxDirs, mailboxDirs } from "./paths.ts";
import { fail, ok, type Result } from "./result.ts";

export const ensureMailbox = (root: string, id: string): MailboxDirs => {
	const dirs = mailboxDirs(root, id);
	ensureDir(dirs.tmp);
	ensureDir(dirs.new);
	ensureDir(dirs.cur);
	return dirs;
};

const fileName = (message: Message): string => `${message.id}.json`;

/** Drops the message into the recipient's `new/` via `tmp/` + rename, so a reader never sees half a file. */
export const deliver = (root: string, message: Message): string => {
	const dirs = ensureMailbox(root, message.to);
	const target = join(dirs.new, fileName(message));
	writeFileAtomic(target, `${JSON.stringify(message)}\n`, { tmpDir: dirs.tmp, durable: true });
	return target;
};

export const pending = (root: string, id: string): string[] => listJsonFiles(mailboxDirs(root, id).new);

export type Claim = { readonly kind: "message"; readonly file: string; readonly message: Message } | { readonly kind: "invalid"; readonly file: string; readonly error: string };

const readMessage = (path: string): Result<Message> => {
	const raw = readTextOrUndefined(path);
	if (raw === undefined) return fail("file vanished");
	const parsed = parseJson(raw);
	if (parsed === undefined) return fail("not valid JSON");
	return parseMessage(parsed);
};

/**
 * Takes ownership of `new/<file>` by renaming it into `cur/`. Rename is atomic, so when several
 * readers race for one message exactly one wins; the others get `undefined`.
 */
export const claim = (root: string, id: string, file: string): Claim | undefined => {
	const dirs = ensureMailbox(root, id);
	const claimed = join(dirs.cur, file);
	if (!moveIfPresent(join(dirs.new, file), claimed)) return undefined;
	const message = readMessage(claimed);
	return message.ok ? { kind: "message", file, message: message.value } : { kind: "invalid", file, error: message.error };
};

/** Hands a claimed message back to `new/`, e.g. when the session it was meant for went away mid-delivery. */
export const unclaim = (root: string, id: string, file: string): boolean => {
	const dirs = mailboxDirs(root, id);
	return moveIfPresent(join(dirs.cur, file), join(dirs.new, file));
};

const sentAt = (file: string): number | undefined => timeOfMessageId(file.replace(/\.json$/, ""));

/**
 * The messages in `id`'s inbox, pending and delivered, sent at or after `since`. Names are
 * time-sortable ids, so older files aren't read; a name that isn't one is read to be safe.
 */
export const messagesSince = (root: string, id: string, since: number): Message[] => {
	const dirs = mailboxDirs(root, id);
	return [dirs.new, dirs.cur].flatMap((dir) =>
		listJsonFiles(dir)
			.filter((file) => (sentAt(file) ?? since) >= since)
			.flatMap((file) => {
				const message = readMessage(join(dir, file));
				return message.ok ? [message.value] : [];
			}),
	);
};

const isOlderThan = (path: string, cutoff: number): boolean => {
	try {
		return statSync(path).mtimeMs < cutoff;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
};

/** Deletes delivered messages older than `maxAgeMs`. Returns how many went. */
export const pruneDelivered = (root: string, id: string, now: number, maxAgeMs: number): number => {
	const dirs = mailboxDirs(root, id);
	const stale = listJsonFiles(dirs.cur)
		.map((file) => join(dirs.cur, file))
		.filter((path) => isOlderThan(path, now - maxAgeMs));
	for (const path of stale) rmSync(path, { force: true });
	return stale.length;
};
