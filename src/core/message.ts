import { newMessageId, type RandomHex, randomHex } from "./ids.ts";
import { isValidId } from "./paths.ts";
import { fail, ok, type Result } from "./result.ts";

export const MESSAGE_VERSION = 1;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_NAME_LENGTH = 64;

/** Why a message exists beyond being said: a sub `ended` (text = its final message) or `died` (its process vanished). */
export type Kind = "ended" | "died";

export interface Sender {
	readonly id: string;
	readonly name?: string;
	readonly cwd?: string;
}

/** One run of a session: its process and when it started. A session resumed is a new life. */
export interface Life {
	readonly pid: number;
	readonly startedAt: number;
}

/**
 * Older messages may also carry `delivery` and `byUser` (from the `follow_up` option, `/msg` and the msg CLI, all
 * cut): they still parse, and both are dropped.
 */
export interface Message {
	readonly v: typeof MESSAGE_VERSION;
	readonly id: string;
	readonly ts: number;
	readonly from: Sender;
	readonly to: string;
	readonly text: string;
	readonly replyTo?: string;
	/** Epoch ms until which the sender is blocked waiting for a reply to this message. */
	readonly awaitingUntil?: number;
	readonly kind?: Kind;
	/** Only on `ended`: the sub went away mid-run, or its last run was aborted, so `text` is its last message, not a finished report. */
	readonly stopped?: true;
	/** Which life of the sender a `died` notice is about, so a parent reports each death once. */
	readonly life?: Life;
}

export interface Draft {
	readonly from: Sender;
	readonly to: string;
	readonly text: string;
	readonly replyTo?: string;
	readonly awaitingUntil?: number;
	readonly kind?: Kind;
	readonly stopped?: boolean;
	readonly life?: Life;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const optionalNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const isKind = (value: unknown): value is Kind => value === "ended" || value === "died";

const parseLife = (value: unknown): Life | undefined => {
	if (!isRecord(value)) return undefined;
	const pid = optionalNumber(value.pid);
	const startedAt = optionalNumber(value.startedAt);
	return pid === undefined || startedAt === undefined ? undefined : { pid, startedAt };
};

export const textBytes = (text: string): number => Buffer.byteLength(text, "utf8");

export const validateText = (text: string): Result<string> => {
	if (!text.trim()) return fail("message is empty");
	const bytes = textBytes(text);
	if (bytes > MAX_TEXT_BYTES) {
		return fail(`message is ${bytes} bytes (max ${MAX_TEXT_BYTES}); write it to a file and send the path instead`);
	}
	return ok(text);
};

export const normalizeName = (name: string | undefined): string | undefined => {
	const trimmed = name?.replace(/\s+/g, " ").trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, MAX_NAME_LENGTH);
};

const parseSender = (value: unknown): Result<Sender> => {
	if (!isRecord(value)) return fail("from: expected an object");
	const id = optionalString(value.id);
	if (!id || !isValidId(id)) return fail("from.id: invalid");
	const name = normalizeName(optionalString(value.name));
	const cwd = optionalString(value.cwd);
	return ok({ id, ...(name ? { name } : {}), ...(cwd ? { cwd } : {}) });
};

export const parseMessage = (value: unknown): Result<Message> => {
	if (!isRecord(value)) return fail("expected an object");
	if (value.v !== MESSAGE_VERSION) return fail(`unsupported version ${JSON.stringify(value.v)}`);
	const id = optionalString(value.id);
	if (!id || !isValidId(id)) return fail("id: invalid");
	const ts = optionalNumber(value.ts);
	if (ts === undefined) return fail("ts: expected a number");
	const from = parseSender(value.from);
	if (!from.ok) return from;
	const to = optionalString(value.to);
	if (!to || !isValidId(to)) return fail("to: invalid");
	const text = optionalString(value.text);
	if (text === undefined) return fail("text: expected a string");
	const replyTo = optionalString(value.replyTo);
	const awaitingUntil = optionalNumber(value.awaitingUntil);
	const kind = isKind(value.kind) ? value.kind : undefined;
	const life = parseLife(value.life);
	return ok({
		v: MESSAGE_VERSION,
		id,
		ts,
		from: from.value,
		to,
		text,
		...(replyTo ? { replyTo } : {}),
		...(awaitingUntil !== undefined ? { awaitingUntil } : {}),
		...(kind ? { kind } : {}),
		...(kind === "ended" && value.stopped === true ? { stopped: true as const } : {}),
		...(life ? { life } : {}),
	});
};

export const createMessage = (draft: Draft, now: number, random: RandomHex = randomHex): Result<Message> => {
	if (!isValidId(draft.from.id)) return fail(`invalid sender id ${JSON.stringify(draft.from.id)}`);
	if (!isValidId(draft.to)) return fail(`invalid recipient id ${JSON.stringify(draft.to)}`);
	if (draft.replyTo !== undefined && !isValidId(draft.replyTo)) return fail(`invalid reply_to ${JSON.stringify(draft.replyTo)}`);
	const text = validateText(draft.text);
	if (!text.ok) return text;
	const name = normalizeName(draft.from.name);
	return ok({
		v: MESSAGE_VERSION,
		id: newMessageId(now, random),
		ts: now,
		from: { id: draft.from.id, ...(name ? { name } : {}), ...(draft.from.cwd ? { cwd: draft.from.cwd } : {}) },
		to: draft.to,
		text: text.value,
		...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
		...(draft.awaitingUntil !== undefined ? { awaitingUntil: draft.awaitingUntil } : {}),
		...(draft.kind ? { kind: draft.kind } : {}),
		...(draft.kind === "ended" && draft.stopped ? { stopped: true as const } : {}),
		...(draft.life ? { life: { pid: draft.life.pid, startedAt: draft.life.startedAt } } : {}),
	});
};

export const partyLabel = (party: { readonly id: string; readonly name?: string | undefined }): string =>
	party.name ?? party.id.slice(0, 8);

/** `name (id)`, or the bare id: how an error names a session, so the next send can use its exact id. */
export const exactLabel = (party: { readonly id: string; readonly name?: string | undefined }): string =>
	party.name ? `${party.name} (${party.id})` : party.id;

const escapeAttr = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeBody = (text: string): string => text.replace(/<\/msg>/gi, "<\\/msg>");

const formatDuration = (ms: number): string => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
};

export const ago = (then: number, now: number): string => `${formatDuration(now - then)} ago`;

export const inFuture = (then: number, now: number): string => formatDuration(then - now);

/** How the receiving session relates to the sender: its parent, its sub (`child`), or neither. */
export type Relation = "parent" | "child";

const senderNote = (message: Message, relation: Relation | undefined): string => {
	const who = partyLabel(message.from);
	if (relation === "parent") return `From your parent session ${who} (an agent, not your user).`;
	if (relation === "child") return `From your sub ${who} (an agent, not your user).`;
	return "Message from another agent session (not your user).";
};

const waitLeft = (message: Message, now: number): string | undefined =>
	message.awaitingUntil !== undefined && message.awaitingUntil > now ? inFuture(message.awaitingUntil, now) : undefined;

const replyHint = (message: Message, now: number): string => {
	const call = `msg_send to "${message.from.id}" with reply_to "${message.id}"`;
	const left = waitLeft(message, now);
	if (left !== undefined) return `${partyLabel(message.from)} is blocked waiting for your reply (${left} left): answer with ${call}.`;
	return `To answer, ${call}. Don't reply just to acknowledge.`;
};

const exitNote = (message: Message, kind: Kind, relation: Relation | undefined): string => {
	const who = `${relation === "child" ? "Your sub" : "Session"} ${partyLabel(message.from)}`;
	const where = message.from.cwd ? ` in ${message.from.cwd}` : "";
	const more = `\`lookup catchup ${message.from.id}\` shows its session.`;
	switch (kind) {
		case "ended":
			if (message.stopped) {
				return `${who} was stopped before it finished (it went away mid-run, or its last run was aborted): above is its last message, not a finished report. Inspect its work${where} before relying on it; ${more}`;
			}
			return `${who} ended; above is its final message, its report. It can't answer anymore; ${more}`;
		case "died":
			return `${who} died: its process is gone and it left no report. Check its work${where} before relying on it.`;
	}
};

const attributes = (message: Message): string =>
	[
		`id="${escapeAttr(message.id)}"`,
		`from="${escapeAttr(partyLabel(message.from))}"`,
		`session="${escapeAttr(message.from.id)}"`,
		...(message.from.cwd ? [`cwd="${escapeAttr(message.from.cwd)}"`] : []),
		...(message.replyTo ? [`reply_to="${escapeAttr(message.replyTo)}"`] : []),
		...(message.kind ? [`kind="${message.kind}"`] : []),
		...(message.stopped ? ['stopped="true"'] : []),
	].join(" ");

/** What the receiving agent sees: the text, framed by who sent it (a peer, its parent or its sub) and how to answer. */
export const renderForAgent = (message: Message, now: number, relation?: Relation): string => {
	const note = message.kind ? exitNote(message, message.kind, relation) : `${senderNote(message, relation)} ${replyHint(message, now)}`;
	return [`<msg ${attributes(message)}>`, escapeBody(message.text), "</msg>", note].join("\n");
};
