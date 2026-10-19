#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { parseArgs } from "node:util";
import { expectation, formatDirectory, targetLabel } from "./core/format.ts";
import { familyOf } from "./core/lineage.ts";
import { allMessages, claim, peek } from "./core/maildir.ts";
import { type Delivery, type Message, normalizeName, partyLabel, type Sender, summarize } from "./core/message.ts";
import { type Env, isValidId, msgRoot } from "./core/paths.ts";
import { directory, HEARTBEAT_EVERY_MS, isLive, listPresence, type Presence, readPresence, writePresence } from "./core/registry.ts";
import { isChildren, type Target } from "./core/resolve.ts";
import { fail, ok, type Result } from "./core/result.ts";
import { canAnswer, findRecipient, liveChildren, post } from "./core/send.ts";
import { isFrom, isFromChildOf, isReplyTo, type MessageMatch } from "./core/waiters.ts";

export interface Io {
	readonly env: Env;
	readonly cwd: string;
	readonly pid: number;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
	readonly stdin: () => string;
}

export const EXIT = { ok: 0, error: 1, usage: 2, timeout: 124 } as const;

const POLL_MS = 200;
const MAX_WAIT_SECONDS = 24 * 60 * 60;
const MAX_OFFLINE_LISTED = 25;

const USAGE = `msg: talk to pi agent sessions on this machine

usage:
  msg ls [--all] [--json]                         you, your parent and children (--all: everyone)
  msg send <to> <text...|-> [--wait <secs>] [--reply-to <id>] [--follow-up]
  msg inbox [--peek] [--json]                     take the messages waiting for you
  msg wait [--from <who>] [--timeout <secs>]      block until a message arrives (exit 124 on timeout)
  msg log [<who>] [-n <count>]                    recent messages to and from you
  msg whoami

<to>/<who>: parent, children (send: every live child; wait: any child), a folder
(/…, ~/…, ./…: the session working there), a session id, name or unique id prefix.
<text> "-" reads the message from stdin. Outside pi (no $PI_SESSION_ID) a message
is marked as sent by the user.

identity (who you are when you send):
  --as <name>   your name; saved, peers address you by it (env MSG_NAME)
  --id <id>     act as this id (env MSG_ID; inside pi, the session's $PI_SESSION_ID; else cli-$USER)

store: $PI_MSG_DIR, else $PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg`;

const options = {
	as: { type: "string" },
	id: { type: "string" },
	all: { type: "boolean" },
	json: { type: "boolean" },
	wait: { type: "string" },
	"reply-to": { type: "string" },
	"follow-up": { type: "boolean" },
	peek: { type: "boolean" },
	from: { type: "string" },
	timeout: { type: "string" },
	n: { type: "string", short: "n" },
	help: { type: "boolean", short: "h" },
} as const;

type Flags = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>["values"];

const USAGE_ERROR = Symbol("usage");

const usageError = (message: string): Error => Object.assign(new Error(message), { [USAGE_ERROR]: true });

const isUsageError = (error: unknown): boolean =>
	error instanceof Error && (USAGE_ERROR in error || ("code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")));

const seconds = (raw: string | undefined, name: string, fallback: number): number => {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) throw usageError(`--${name} takes a number of seconds`);
	return Math.min(MAX_WAIT_SECONDS, value);
};

const count = (raw: string | undefined, fallback: number): number => {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw usageError("-n takes a positive whole number");
	return value;
};

const sanitizeId = (raw: string): string => raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "user";

const defaultId = (env: Env): string =>
	env.MSG_ID?.trim() || env.PI_SESSION_ID?.trim() || `cli-${sanitizeId(env.USER?.trim() || userInfo().username)}`;

interface Me {
	readonly root: string;
	readonly id: string;
	readonly presence: Presence;
	/** A live pi session (with the extension) owns this id; it gets the messages, not the CLI. */
	readonly ownedBySession: boolean;
}

/** Records the CLI as a reachable identity, without clobbering a live pi session that owns the id. */
const touch = (io: Io, root: string, id: string, name: string | undefined): Me => {
	const now = io.now();
	const existing = readPresence(root, id);
	if (existing && existing.mode !== "cli" && isLive(existing, now)) return { root, id, presence: existing, ownedBySession: true };
	const keptName = name ?? existing?.name;
	const presence: Presence = {
		v: 1,
		id,
		...(keptName ? { name: keptName } : {}),
		cwd: io.cwd,
		pid: io.pid,
		mode: "cli",
		activity: "idle",
		startedAt: existing?.mode === "cli" ? existing.startedAt : now,
		heartbeatAt: now,
	};
	writePresence(root, presence);
	return { root, id, presence, ownedBySession: false };
};

const whoAmI = (io: Io, flags: Flags): Me => {
	const id = flags.id?.trim() || defaultId(io.env);
	if (!isValidId(id)) throw usageError(`invalid id ${JSON.stringify(id)}`);
	const name = normalizeName(flags.as ?? io.env.MSG_NAME);
	return touch(io, msgRoot(io.env), id, name);
};

const sender = (me: Me): Sender => ({ id: me.id, ...(me.presence.name ? { name: me.presence.name } : {}), cwd: me.presence.cwd });

const marks = (message: Message): string => [message.kind, message.byUser ? "from the user" : undefined].filter(Boolean).map((mark) => ` · ${mark}`).join("");

const printMessage = (io: Io, message: Message): void => {
	const reply = message.replyTo ? ` · re ${message.replyTo}` : "";
	io.out(`── ${partyLabel(message.from)} (${message.from.id})${marks(message)} · ${message.id}${reply} · ${new Date(message.ts).toLocaleString()}`);
	io.out(message.text);
	if (message.awaitingUntil !== undefined && message.awaitingUntil > io.now()) {
		io.out(`(waiting for your reply: msg send ${message.from.id} --reply-to ${message.id} "…")`);
	}
};

/** Takes the oldest pending message `match` accepts; leaves the rest for `msg inbox`. */
const takeMatching = (me: Me, match: MessageMatch): Message | undefined => {
	for (const entry of peek(me.root, me.id)) {
		if (entry.kind !== "message" || !match(entry.message)) continue;
		const claimed = claim(me.root, me.id, entry.file);
		if (claimed?.kind === "message") return claimed.message;
	}
	return undefined;
};

/** Polls the inbox, heartbeating so peers see this identity as live while it waits. */
const waitFor = async (io: Io, me: Me, match: MessageMatch, timeoutMs: number): Promise<Message | undefined> => {
	const deadline = io.now() + timeoutMs;
	let beat = 0;
	for (;;) {
		const now = io.now();
		if (!me.ownedBySession && now - beat >= HEARTBEAT_EVERY_MS / 2) {
			writePresence(me.root, { ...me.presence, pid: io.pid, heartbeatAt: now });
			beat = now;
		}
		const found = takeMatching(me, match);
		if (found) return found;
		if (now >= deadline) return undefined;
		await io.sleep(Math.min(POLL_MS, Math.max(1, deadline - now)));
	}
};

const ownedNote = (me: Me): string =>
	`note: a live pi session with the msg extension owns ${me.id}; it takes messages as they arrive, so the CLI may not see them.`;

const cmdLs = (io: Io, flags: Flags): number => {
	const me = whoAmI(io, flags);
	const now = io.now();
	const records = listPresence(me.root);
	const dir = directory(records, now);
	if (flags.json) {
		const family = familyOf(records, me.presence);
		io.out(JSON.stringify({ you: me.presence, parent: family.parent ?? family.parentId, children: family.children, live: dir.live, offline: dir.offline }, null, 2));
		return EXIT.ok;
	}
	io.out(formatDirectory(dir, me.presence, now, homedir(), { all: flags.all === true, maxOffline: MAX_OFFLINE_LISTED }));
	return EXIT.ok;
};

/** One session, or every live child for `children`. */
const recipientsOf = (io: Io, me: Me, to: string): Result<Target[]> => {
	if (!isChildren(to)) {
		const found = findRecipient(me.root, me.presence, to, io.now());
		return found.ok ? ok([found.value]) : found;
	}
	const children = liveChildren(me.root, me.id, io.now());
	return children.length > 0 ? ok(children) : fail(`${partyLabel(me.presence)} has no live children`);
};

const cmdSend = async (io: Io, flags: Flags, args: readonly string[]): Promise<number> => {
	const [to, ...words] = args;
	if (!to || words.length === 0) throw usageError("msg send <to> <text...|->");
	const text = words.length === 1 && words[0] === "-" ? io.stdin() : words.join(" ");
	const waitSeconds = seconds(flags.wait, "wait", 0);
	const delivery: Delivery = flags["follow-up"] ? "followUp" : "steer";
	const byUser = !io.env.PI_SESSION_ID?.trim();
	const me = whoAmI(io, flags);
	const now = io.now();
	const found = recipientsOf(io, me, to);
	if (!found.ok) {
		io.err(`msg: ${found.error}; \`msg ls\` shows who's around`);
		return EXIT.error;
	}
	const targets = found.value;
	const [single] = targets;
	const willWait = waitSeconds > 0 && targets.length === 1 && single !== undefined && canAnswer(single);
	const replyTo = flags["reply-to"]?.trim();
	const outgoing = { text, delivery, byUser, ...(replyTo ? { replyTo } : {}), ...(willWait ? { awaitingUntil: now + waitSeconds * 1_000 } : {}) };
	const sent: Message[] = [];
	for (const target of targets) {
		const posted = post(me.root, sender(me), target, outgoing, now);
		if (!posted.ok) {
			io.err(`msg: ${posted.error}`);
			return EXIT.error;
		}
		sent.push(posted.value);
		io.out(`sent ${posted.value.id} to ${targetLabel(target)}: ${expectation(target, delivery, now)}`);
	}
	if (waitSeconds > 0 && !willWait) io.out(targets.length > 1 ? "not waiting on a fan-out: `msg wait --from children` collects replies" : "not waiting: nobody there can answer right now");
	const [first] = sent;
	if (!willWait || !first) return EXIT.ok;
	if (me.ownedBySession) io.err(ownedNote(me));
	const reply = await waitFor(io, me, isReplyTo(first), waitSeconds * 1_000);
	if (!reply) {
		io.out(`no reply within ${waitSeconds}s (a later one waits in \`msg inbox\`)`);
		return EXIT.timeout;
	}
	printMessage(io, reply);
	return EXIT.ok;
};

const cmdInbox = (io: Io, flags: Flags): number => {
	const me = whoAmI(io, flags);
	if (me.ownedBySession) io.err(ownedNote(me));
	const entries = peek(me.root, me.id);
	const messages = flags.peek
		? entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []))
		: entries.flatMap((entry) => {
				const claimed = claim(me.root, me.id, entry.file);
				return claimed?.kind === "message" ? [claimed.message] : [];
			});
	if (flags.json) {
		for (const message of messages) io.out(JSON.stringify(message));
		return EXIT.ok;
	}
	if (messages.length === 0) {
		io.out("no new messages");
		return EXIT.ok;
	}
	for (const message of messages) printMessage(io, message);
	return EXIT.ok;
};

/** Anyone, any child of yours (looked up as messages arrive), or one session. */
const waitMatch = (io: Io, me: Me, from: string | undefined): Result<MessageMatch> => {
	if (!from?.trim()) return ok(isFrom(undefined));
	if (isChildren(from)) return ok(isFromChildOf(me.id, (id) => readPresence(me.root, id)?.parent));
	const found = findRecipient(me.root, me.presence, from, io.now());
	return found.ok ? ok(isFrom(found.value.id)) : found;
};

const cmdWait = async (io: Io, flags: Flags): Promise<number> => {
	const timeoutSeconds = seconds(flags.timeout, "timeout", 300);
	const me = whoAmI(io, flags);
	if (me.ownedBySession) io.err(ownedNote(me));
	const match = waitMatch(io, me, flags.from);
	if (!match.ok) {
		io.err(`msg: ${match.error}`);
		return EXIT.error;
	}
	const message = await waitFor(io, me, match.value, timeoutSeconds * 1_000);
	if (!message) {
		io.out(`no message within ${timeoutSeconds}s`);
		return EXIT.timeout;
	}
	printMessage(io, message);
	return EXIT.ok;
};

const cmdLog = (io: Io, flags: Flags, args: readonly string[]): number => {
	const me = whoAmI(io, flags);
	const limit = count(flags.n, 20);
	const [who] = args;
	const peer = who ? findRecipient(me.root, me.presence, who, io.now()) : undefined;
	if (peer && !peer.ok) {
		io.err(`msg: ${peer.error}`);
		return EXIT.error;
	}
	const peerId = peer?.ok ? peer.value.id : undefined;
	const names = new Map(listPresence(me.root).map((record) => [record.id, partyLabel(record)]));
	const mine = allMessages(me.root)
		.filter(({ message }) => message.from.id === me.id || message.to === me.id)
		.filter(({ message }) => peerId === undefined || message.from.id === peerId || message.to === peerId)
		.slice(-limit);
	if (mine.length === 0) {
		io.out("no messages");
		return EXIT.ok;
	}
	for (const { message, state } of mine) {
		const recipient = message.to === me.id ? "you" : (names.get(message.to) ?? message.to.slice(0, 8));
		io.out(`${summarize(message, recipient)}${state === "pending" ? "  (unread)" : ""}  [${message.id}]`);
	}
	return EXIT.ok;
};

const cmdWhoami = (io: Io, flags: Flags): number => {
	const me = whoAmI(io, flags);
	io.out(`${partyLabel(me.presence)} · ${me.id}${me.ownedBySession ? ` · live ${me.presence.mode} session` : ""}`);
	io.out(`store: ${me.root}`);
	return EXIT.ok;
};

export const run = async (argv: readonly string[], io: Io): Promise<number> => {
	try {
		const { values: flags, positionals } = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
		const [command, ...args] = positionals;
		if (flags.help || !command) {
			io.out(USAGE);
			return command || flags.help ? EXIT.ok : EXIT.usage;
		}
		switch (command) {
			case "ls":
			case "list":
				return cmdLs(io, flags);
			case "send":
				return await cmdSend(io, flags, args);
			case "inbox":
				return cmdInbox(io, flags);
			case "wait":
				return await cmdWait(io, flags);
			case "log":
				return cmdLog(io, flags, args);
			case "whoami":
				return cmdWhoami(io, flags);
			default:
				throw usageError(`unknown command "${command}"`);
		}
	} catch (error) {
		io.err(`msg: ${error instanceof Error ? error.message : String(error)}`);
		if (!isUsageError(error)) return EXIT.error;
		io.err("try: msg --help");
		return EXIT.usage;
	}
};

const processIo = (): Io => ({
	env: process.env,
	cwd: process.cwd(),
	pid: process.pid,
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	out: (text) => process.stdout.write(`${text}\n`),
	err: (text) => process.stderr.write(`${text}\n`),
	stdin: () => readFileSync(0, "utf8"),
});

if (import.meta.main) {
	process.exitCode = await run(process.argv.slice(2), processIo());
}
