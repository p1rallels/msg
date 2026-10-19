import { type FSWatcher, watch } from "node:fs";
import { homedir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MSG_COMMAND_USAGE, parseMsgCommand } from "./core/command.ts";
import { expectation, formatDirectory, targetLabel } from "./core/format.ts";
import { sweepOrphans } from "./core/housekeeping.ts";
import { assistantWords, childrenOf, diedText, endedText, inheritedParent, lastWordsIn, relationOf, watchChildren } from "./core/lineage.ts";
import { ensureMailbox, pruneDelivered } from "./core/maildir.ts";
import { type Delivery, type Message, normalizeName, partyLabel, type Relation, renderForAgent, type Sender } from "./core/message.ts";
import { isValidId, mailboxDirs, msgRoot } from "./core/paths.ts";
import { DEFAULT_WAKE_BUDGET, deliveryAction, recentWakes, type SessionState, wakeAllowed } from "./core/policy.ts";
import { pumpOnce } from "./core/pump.ts";
import { directory, HEARTBEAT_EVERY_MS, listPresence, type Mode, type Presence, pruneOffline, readPresence, writePresence } from "./core/registry.ts";
import { isChildren, type Target } from "./core/resolve.ts";
import { fail, ok, type Result } from "./core/result.ts";
import { canAnswer, findRecipient, liveChildren, type Outgoing, post, postExit } from "./core/send.ts";
import { createWaiters, isFrom, isFromChildOf, isReplyTo, type MessageMatch, type Waiters, type WaitOutcome } from "./core/waiters.ts";

const CUSTOM_TYPE = "msg";
const STATUS_KEY = "msg";
const TICK_MS = 2_000;
const SCAN_EVERY_MS = HEARTBEAT_EVERY_MS;
/** Two ticks further apart than this mean the process was suspended (the machine slept). */
const WAKE_GAP_MS = 10_000;
const PUMP_DEBOUNCE_MS = 25;
const STARTUP_GRACE_MS = 3_000;
const DELIVERED_TTL_MS = 7 * 24 * 60 * 60_000;
const OFFLINE_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 3_600;
const MAX_OFFLINE_LISTED = 15;
const COLLAPSED_LINES = 12;

interface Live {
	readonly id: string;
	readonly ctx: ExtensionContext;
	readonly mode: Mode;
	readonly startedAt: number;
	readonly waiters: Waiters;
	readonly timer: ReturnType<typeof setInterval>;
	presence: Presence;
	watcher: FSWatcher | undefined;
	wakes: number[];
	pumpQueued: boolean;
	/** Messages whose sender is blocked waiting for our reply: id -> who and until when. */
	awaited: Map<string, { readonly from: string; readonly until: number }>;
	status: string | undefined;
	/** Children seen live and still owed a `died` notice should they vanish. */
	seen: ReadonlySet<string>;
	lastScanAt: number;
	lastTickAt: number;
	/** Since when this process has been running without a suspension gap. */
	awakeSince: number;
	/** The newest assistant text: the report an `ended` notice carries to the parent. */
	lastWords: string | undefined;
}

/** How a session stops: `ended` tells its parent (it's over), `quiet` doesn't (a reload, a restart of the same session). */
type Stop = "ended" | "quiet";

type ToolText = { type: "text"; text: string };
const toolText = (text: string): ToolText[] => [{ type: "text", text }];

/** pi-web hosts sessions through the SDK in RPC mode; tell it apart so peers know a phone may be watching. */
const hostMode = (mode: ExtensionContext["mode"]): Mode =>
	mode === "rpc" && process.argv.some((arg) => arg.includes("pi-web")) ? "web" : mode;

const clampSeconds = (value: number | undefined, fallback: number): number =>
	Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.round(value ?? fallback)));

const toDelivery = (value: "steer" | "follow_up" | undefined): Delivery => (value === "follow_up" ? "followUp" : "steer");

const withName = (presence: Presence, name: string | undefined): Presence => {
	const { name: _replaced, ...rest } = presence;
	return name ? { ...rest, name } : rest;
};

const clipLines = (text: string, max: number): string => {
	const lines = text.split("\n");
	return lines.length <= max ? text : `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines`;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const senderOf = (presence: Presence): Sender => ({ id: presence.id, ...(presence.name ? { name: presence.name } : {}), cwd: presence.cwd });

const describeReply = (outcome: WaitOutcome, who: string, seconds: number): string => {
	switch (outcome.kind) {
		case "message": {
			const { message } = outcome;
			if (message.kind === "ended") return `${who} ended before replying. Its final message:\n${message.text}`;
			if (message.kind === "died") return `${who} died before replying: ${message.text}`;
			const by = message.byUser ? `Your user replied through ${who}` : `${who} replied`;
			return `${by} (${message.id}):\n${message.text}`;
		}
		case "timeout":
			return `No reply from ${who} within ${seconds}s. A later reply arrives as a normal message.`;
		case "aborted":
			return `Stopped waiting for ${who}. A later reply arrives as a normal message.`;
	}
};

const headline = (message: Message): string => {
	const who = partyLabel(message.from);
	if (message.kind === "ended") return `✉ ${who} ended`;
	if (message.kind === "died") return `✉ ${who} died`;
	return message.byUser ? `✉ your user via ${who}` : `✉ ${who}`;
};

export default function msgExtension(pi: ExtensionAPI): void {
	const root = msgRoot(process.env);
	const home = homedir();
	let live: Live | undefined;
	/** Why msg couldn't start in this session, for the tools to explain. */
	let unavailable: string | undefined;

	const notify = (current: Live, text: string, level: "info" | "warning" | "error"): void => {
		try {
			if (current.ctx.hasUI) current.ctx.ui.notify(text, level);
		} catch {
			// the session is going away; nothing to tell
		}
	};

	const savePresence = (current: Live, presence: Presence): void => {
		current.presence = presence;
		try {
			writePresence(root, presence);
		} catch (error) {
			console.error(`[msg] could not write presence: ${errorText(error)}`);
		}
	};

	const readSafely = (id: string): Presence | undefined => {
		try {
			return readPresence(root, id);
		} catch {
			return undefined;
		}
	};

	const listSafely = (): Presence[] => {
		try {
			return listPresence(root);
		} catch {
			return [];
		}
	};

	const relationTo = (current: Live, senderId: string): Relation | undefined => relationOf(current.presence, senderId, readSafely(senderId));

	/** A child that ends tells its parent, with its last words. Mail to an offline parent waits in its inbox. */
	const reportEnd = (current: Live, now: number): void => {
		const parent = current.presence.parent;
		if (parent === undefined) return;
		try {
			const posted = postExit(root, senderOf(current.presence), parent, "ended", endedText(current.lastWords, current.id), now);
			if (!posted.ok) console.error(`[msg] could not tell the parent session this one ended: ${posted.error}`);
		} catch (error) {
			console.error(`[msg] could not tell the parent session this one ended: ${errorText(error)}`);
		}
	};

	const stop = (how: Stop): void => {
		const current = live;
		if (!current) return;
		live = undefined;
		clearInterval(current.timer);
		current.watcher?.close();
		current.waiters.cancelAll();
		try {
			if (current.status !== undefined) current.ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// the ctx is already gone
		}
		const now = Date.now();
		if (how === "ended") reportEnd(current, now);
		savePresence(current, { ...current.presence, activity: "idle", endedAt: now });
	};

	/** Throws once pi has disposed the session (pi-web disposes without session_shutdown). */
	const sessionState = (current: Live, now: number): SessionState => ({
		mode: current.mode,
		idle: current.ctx.isIdle(),
		streaming: current.ctx.signal !== undefined,
		wakeAllowed: wakeAllowed(current.wakes, now, DEFAULT_WAKE_BUDGET),
	});

	const accepting = (current: Live): boolean => {
		if (current.waiters.size() > 0) return true;
		const now = Date.now();
		const state = sessionState(current, now);
		if (state.idle && now - current.startedAt < STARTUP_GRACE_MS) return false;
		return deliveryAction(state, "steer").kind !== "hold";
	};

	const rememberAwaited = (current: Live, message: Message, now: number): void => {
		for (const [id, entry] of current.awaited) if (entry.until <= now) current.awaited.delete(id);
		if (message.awaitingUntil !== undefined && message.awaitingUntil > now) current.awaited.set(message.id, { from: message.from.id, until: message.awaitingUntil });
	};

	/** True when `replyTo` names a message whose sender (`to`) is still blocked waiting on it. Forgets it either way. */
	const takeAwaited = (current: Live, replyTo: string | undefined, to: string, now: number): boolean => {
		const entry = replyTo ? current.awaited.get(replyTo) : undefined;
		if (!entry || !replyTo) return false;
		current.awaited.delete(replyTo);
		return entry.from === to && entry.until > now;
	};

	const updateStatus = (current: Live, records: readonly Presence[], now: number): void => {
		if (!current.ctx.hasUI) return;
		const dir = directory(records, now);
		const peers = dir.live.filter((record) => record.id !== current.id).length;
		const children = dir.live.filter((record) => record.parent === current.id).length;
		const text = [`✉ ${partyLabel(current.presence)}`, ...(children > 0 ? [`${children} children`] : []), ...(peers > 0 ? [`${peers} live`] : [])].join(" · ");
		if (text === current.status) return;
		current.status = text;
		current.ctx.ui.setStatus(STATUS_KEY, text);
	};

	const inject = (current: Live, message: Message): "delivered" | "held" => {
		const now = Date.now();
		const action = deliveryAction(sessionState(current, now), message.delivery);
		const content = renderForAgent(message, now, relationTo(current, message.from.id));
		const custom = { customType: CUSTOM_TYPE, content, display: true, details: message };
		switch (action.kind) {
			case "hold":
				return "held";
			case "append":
				pi.sendMessage(custom, { triggerTurn: false });
				rememberAwaited(current, message, now);
				notify(current, `msg: ${partyLabel(message.from)} wrote, but this session woke ${DEFAULT_WAKE_BUDGET.max}x without you; not waking it again until you prompt`, "warning");
				return "delivered";
			case "inject":
				pi.sendMessage(custom, { triggerTurn: true, deliverAs: action.deliverAs });
				rememberAwaited(current, message, now);
				if (action.wakes && message.kind === undefined) current.wakes = [...recentWakes(current.wakes, now, DEFAULT_WAKE_BUDGET), now];
				return "delivered";
		}
	};

	const isStale = (current: Live): boolean => {
		try {
			current.ctx.isIdle();
			return false;
		} catch {
			return true;
		}
	};

	/** Stops when pi disposed the session; otherwise logs and lets the next tick retry. */
	const handleFailure = (current: Live, error: unknown): void => {
		if (isStale(current)) {
			stop("ended");
			return;
		}
		console.error(`[msg] delivery failed, retrying: ${errorText(error)}`);
	};

	const pump = (current: Live): void => {
		if (live !== current) return;
		try {
			const report = pumpOnce(root, current.id, {
				accepting: () => accepting(current),
				offer: current.waiters.offer,
				deliver: (message) => inject(current, message),
			});
			if (report.invalid.length > 0) notify(current, `msg: skipped ${report.invalid.length} unreadable message file(s)`, "warning");
			if (report.failure !== undefined) handleFailure(current, report.failure);
		} catch (error) {
			handleFailure(current, error);
		}
	};

	const schedulePump = (current: Live): void => {
		if (current.pumpQueued || live !== current) return;
		current.pumpQueued = true;
		const timer = setTimeout(() => {
			current.pumpQueued = false;
			pump(current);
		}, PUMP_DEBOUNCE_MS);
		timer.unref?.();
	};

	/**
	 * Looks in on the children: every record on a scan (finds new ones), else just the ones seen live.
	 * A child that vanished without ending gets a `died` notice in our own inbox, delivered like any message.
	 */
	const watchFamily = (current: Live, now: number, records: readonly Presence[] | undefined): void => {
		const known = records ?? [...current.seen].flatMap((id) => readSafely(id) ?? []);
		const watched = watchChildren(childrenOf(known, current.id), current.seen, now, current.awakeSince);
		current.seen = watched.seen;
		for (const death of watched.died) {
			try {
				const posted = postExit(root, senderOf(death.child), current.id, "died", diedText(death, now), now);
				if (!posted.ok) console.error(`[msg] could not record that ${partyLabel(death.child)} died: ${posted.error}`);
			} catch (error) {
				console.error(`[msg] could not record that ${partyLabel(death.child)} died: ${errorText(error)}`);
			}
		}
	};

	const scan = (current: Live, now: number): void => {
		current.lastScanAt = now;
		const records = listSafely();
		watchFamily(current, now, records);
		try {
			updateStatus(current, records, now);
		} catch {
			// a status line is cosmetic
		}
	};

	const tick = (current: Live): void => {
		if (live !== current) return;
		const now = Date.now();
		let idle: boolean;
		let name: string | undefined;
		try {
			idle = current.ctx.isIdle();
			name = normalizeName(pi.getSessionName());
		} catch {
			stop("ended");
			return;
		}
		if (now - current.lastTickAt > WAKE_GAP_MS) current.awakeSince = now;
		current.lastTickAt = now;
		const activity = idle ? "idle" : "busy";
		const { presence } = current;
		if (activity !== presence.activity || name !== presence.name || now - presence.heartbeatAt >= HEARTBEAT_EVERY_MS) {
			if (name !== presence.name) current.lastScanAt = 0;
			savePresence(current, { ...withName(presence, name), activity, heartbeatAt: now });
		}
		if (now - current.lastScanAt >= SCAN_EVERY_MS) scan(current, now);
		else watchFamily(current, now, undefined);
		pump(current);
	};

	const watchInbox = (current: Live): FSWatcher | undefined => {
		try {
			const watcher = watch(mailboxDirs(root, current.id).new, { persistent: false }, () => schedulePump(current));
			watcher.on("error", () => {
				watcher.close();
				current.watcher = undefined;
			});
			return watcher;
		} catch {
			return undefined;
		}
	};

	const housekeeping = (id: string, now: number): void => {
		try {
			pruneDelivered(root, id, now, DELIVERED_TTL_MS);
			pruneOffline(root, now, OFFLINE_TTL_MS);
			sweepOrphans(root, now);
		} catch {
			// best effort; a later session retries
		}
	};

	const begin = (ctx: ExtensionContext): void => {
		const id = ctx.sessionManager.getSessionId();
		if (!isValidId(id)) throw new Error(`session id ${JSON.stringify(id)} can't name a mailbox`);
		ensureMailbox(root, id);
		const now = Date.now();
		const name = normalizeName(pi.getSessionName());
		const mode = hostMode(ctx.mode);
		const parent = inheritedParent(process.env, id, mode);
		const presence: Presence = {
			v: 1,
			id,
			...(name ? { name } : {}),
			...(parent ? { parent } : {}),
			cwd: ctx.cwd,
			pid: process.pid,
			mode,
			activity: ctx.isIdle() ? "idle" : "busy",
			startedAt: now,
			heartbeatAt: now,
		};
		writePresence(root, presence);
		const timer = setInterval(() => {
			if (live) tick(live);
		}, TICK_MS);
		timer.unref?.();
		const current: Live = {
			id,
			ctx,
			mode,
			startedAt: now,
			waiters: createWaiters(),
			timer,
			presence,
			watcher: undefined,
			wakes: [],
			pumpQueued: false,
			awaited: new Map(),
			status: undefined,
			seen: new Set(),
			lastScanAt: 0,
			lastTickAt: now,
			awakeSince: now,
			lastWords: lastWordsIn(ctx.sessionManager.getBranch()),
		};
		live = current;
		current.watcher = watchInbox(current);
		scan(current, now);
		housekeeping(id, now);
	};

	const start = (ctx: ExtensionContext): void => {
		stop(live !== undefined && live.id !== ctx.sessionManager.getSessionId() ? "ended" : "quiet");
		unavailable = undefined;
		try {
			begin(ctx);
		} catch (error) {
			stop("quiet");
			unavailable = `msg can't use its store at ${root}: ${errorText(error)}. Point PI_MSG_DIR at a folder this session can write.`;
			console.error(`[msg] ${unavailable}`);
		}
	};

	const requireLive = (): Live => {
		if (live) return live;
		throw new Error(unavailable ?? "msg is not running in this session (it starts with the session; try again in a moment)");
	};

	/** One session, or every live child for `children`. */
	const recipientsOf = (current: Live, to: string, now: number): Result<Target[]> => {
		if (isChildren(to)) {
			const children = liveChildren(root, current.id, now);
			return children.length > 0 ? ok(children) : fail("you have no live children (msg_list shows your family)");
		}
		const found = findRecipient(root, current.presence, to, now);
		return found.ok ? ok([found.value]) : fail(`${found.error}. msg_list shows who's around`);
	};

	const sendAll = (current: Live, targets: readonly Target[], outgoing: Outgoing, now: number): Result<{ target: Target; message: Message }[]> => {
		const sent: { target: Target; message: Message }[] = [];
		for (const target of targets) {
			const posted = post(root, senderOf(current.presence), target, outgoing, now);
			if (!posted.ok) return fail(posted.error);
			sent.push({ target, message: posted.value });
		}
		return ok(sent);
	};

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", (event) => stop(event.reason === "reload" ? "quiet" : "ended"));
	pi.on("input", (event) => {
		if (event.source !== "extension" && live) live.wakes = [];
	});
	pi.on("message_end", (event) => {
		const words = assistantWords(event.message);
		if (words !== undefined && live) live.lastWords = words;
	});

	pi.registerMessageRenderer<Message>(CUSTOM_TYPE, (custom, { expanded, outputPad }, theme) => {
		const message = custom.details;
		if (!message) return undefined;
		const reply = message.replyTo ? ` · re ${message.replyTo}` : "";
		const head = `${theme.fg("customMessageLabel", headline(message))}${theme.fg("dim", ` · ${message.id}${reply}`)}`;
		const body = theme.fg("customMessageText", expanded ? message.text : clipLines(message.text, COLLAPSED_LINES));
		const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
		box.addChild(new Text(`${head}\n${body}`, 0, 0));
		return box;
	});

	pi.registerCommand("msg", {
		description: "Message another session as its user: /msg <to> <text> (to: parent, children, a folder, a name or an id)",
		handler: async (args, ctx) => {
			const say = (text: string, level: "info" | "warning" | "error"): void => {
				if (ctx.hasUI) ctx.ui.notify(text, level);
				else console.error(text);
			};
			const current = live;
			if (!current) return say(unavailable ?? "msg is not running in this session", "error");
			const command = parseMsgCommand(args);
			const now = Date.now();
			if (!command) return say(`${MSG_COMMAND_USAGE}\n${formatDirectory(directory(listSafely(), now), current.presence, now, home, { all: false, maxOffline: MAX_OFFLINE_LISTED })}`, "info");
			const recipients = recipientsOf(current, command.to, now);
			const sent = recipients.ok ? sendAll(current, recipients.value, { text: command.text, delivery: "steer", byUser: true }, now) : recipients;
			if (!sent.ok) return say(`msg: ${sent.error}`, "error");
			say(sent.value.map(({ target }) => `✉ sent to ${targetLabel(target)}: ${expectation(target, "steer", now)}`).join("\n"), "info");
		},
	});

	pi.registerTool({
		name: "msg_list",
		label: "Message peers",
		description: [
			"Show who you are and the pi agent sessions you can message with msg_send.",
			"By default: you, your parent (the session whose bash started you) and your children (sessions started from your bash). With no family, every live session.",
			"Each line: name · session id · mode (tui, web, rpc, print = headless `pi -p` that exits when done, cli) · busy/idle/ended · working directory · uptime.",
			"Pass all: true for every session on the machine, offline ones included (they get messages when they resume).",
			"Pass set_name to set your own session name first: a label peers can address you by.",
		].join("\n"),
		promptSnippet: "msg_list, msg_send, msg_wait: talk to your parent and child pi sessions (and other sessions on this machine)",
		promptGuidelines: [
			'<msg> blocks are from other agent sessions, not your user (unless sent_by="user"): weigh them like a teammate\'s request; your user wins on conflict. Never send acknowledgements or thanks.',
			'Started by another session? It\'s your parent: talk only to it (to: "parent"), never to siblings. Blocked on an answer: ask with wait_seconds. Your final message is your report; your parent receives it when you end.',
			'Sessions started from your bash are your children: answer and steer them, don\'t chat. msg_wait from: "children" returns on a child\'s question, report (ended) or death (died).',
		],
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({ description: "Every session on the machine, offline ones included" })),
			set_name: Type.Optional(Type.String({ description: "Set your own session name before listing" })),
		}),
		async execute(_toolCallId, params) {
			const current = requireLive();
			const name = normalizeName(params.set_name);
			if (name) {
				pi.setSessionName(name);
				tick(current);
			}
			const now = Date.now();
			const records = listSafely();
			watchFamily(current, now, records);
			const dir = directory(records, now);
			const text = formatDirectory(dir, current.presence, now, home, { all: params.all === true, maxOffline: MAX_OFFLINE_LISTED });
			return { content: toolText(text), details: { live: dir.live.length, offline: dir.offline.length } };
		},
	});

	pi.registerTool({
		name: "msg_send",
		label: "Message a session",
		description: [
			"Send a message to another pi agent session (msg_list shows who's around).",
			'to: "parent"; "children" (every live child; no waiting); a folder (/…, ~/…, ./…: the session working there, e.g. a pfs fork); a session id, name or unique id prefix.',
			"delivery: steer (default) reaches a busy recipient at its next step, mid-task; follow_up waits until it finishes its current task. An idle recipient wakes up and handles it either way.",
			"wait_seconds: block until the recipient replies and get the reply as this tool's result. Use it when you need the answer to continue; leave it out for heads-ups and handoffs.",
			"reply_to: the id of the message you're answering, so a sender that is waiting gets your reply.",
			"Offline recipients get the message when their session resumes.",
		].join("\n"),
		parameters: Type.Object({
			to: Type.String({ description: 'Recipient: "parent", "children", a folder path, or a session id, name or unique id prefix' }),
			message: Type.String({ description: "The message text" }),
			reply_to: Type.Optional(Type.String({ description: "Id of the message you are answering" })),
			wait_seconds: Type.Optional(Type.Number({ description: `Block up to this long for a reply (max ${MAX_WAIT_SECONDS})` })),
			delivery: Type.Optional(StringEnum(["steer", "follow_up"] as const, { description: "steer (default): next step; follow_up: after its current task" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const current = requireLive();
			const requestedWait = clampSeconds(params.wait_seconds, 0);
			const delivery = toDelivery(params.delivery);
			const now = Date.now();
			const recipients = recipientsOf(current, params.to, now);
			if (!recipients.ok) throw new Error(recipients.error);
			const targets = recipients.value;
			const [single] = targets;
			const waitSeconds = targets.length === 1 && single && canAnswer(single) ? requestedWait : 0;
			const replyTo = params.reply_to?.trim();
			const sent = sendAll(
				current,
				targets,
				{ text: params.message, delivery, ...(replyTo ? { replyTo } : {}), ...(waitSeconds > 0 ? { awaitingUntil: now + waitSeconds * 1_000 } : {}) },
				now,
			);
			if (!sent.ok) throw new Error(sent.error);
			const lines = sent.value.map(({ target, message }) => {
				const unblocks = takeAwaited(current, message.replyTo, target.id, now);
				const when = unblocks ? "it is blocked waiting for this reply and gets it right away" : expectation(target, delivery, now);
				return `Sent ${message.id} to ${targetLabel(target)}: ${when}.`;
			});
			const [first] = sent.value;
			if (!first) throw new Error("nobody to send to");
			if (sent.value.length > 1) {
				const note = requestedWait > 0 ? '\nNot waiting on a fan-out: msg_wait from: "children" collects the replies.' : "";
				const details = { message: first.message, messages: sent.value.map((item) => item.message), to: params.to, recipients: sent.value.map((item) => item.target.id) };
				return { content: toolText(`${lines.join("\n")}${note}`), details };
			}
			if (waitSeconds === 0) {
				const note = requestedWait > 0 ? " Not waiting: nobody there can answer right now." : "";
				return { content: toolText(`${lines.join("\n")}${note}`), details: { message: first.message, to: first.target.id, live: first.target.live } };
			}
			const who = partyLabel(first.target.presence ?? { id: first.target.id });
			const summary = lines.join("\n");
			onUpdate?.({ content: toolText(`${summary}\nWaiting up to ${waitSeconds}s for ${who} to reply…`), details: { message: first.message, to: first.target.id, live: true } });
			const outcome = await current.waiters.wait(isReplyTo(first.message), waitSeconds * 1_000, signal);
			return {
				content: toolText(`${summary}\n${describeReply(outcome, who, waitSeconds)}`),
				details: {
					message: first.message,
					to: first.target.id,
					live: true,
					reply: outcome.kind === "message" ? outcome.message : undefined,
					outcome: outcome.kind,
				},
			};
		},
	});

	/** What msg_wait's `from` means: anyone, any of your children, or one session. */
	const waitFilter = (current: Live, from: string | undefined): Result<{ match: MessageMatch; who: string; id?: string }> => {
		if (!from?.trim()) return ok({ match: isFrom(undefined), who: "anyone" });
		if (isChildren(from)) {
			scan(current, Date.now());
			return ok({ match: isFromChildOf(current.id, (id) => readSafely(id)?.parent), who: "your children" });
		}
		const sender = findRecipient(root, current.presence, from, Date.now());
		if (!sender.ok) return fail(`${sender.error}. msg_list shows who's around`);
		return ok({ match: isFrom(sender.value.id), who: targetLabel(sender.value), id: sender.value.id });
	};

	pi.registerTool({
		name: "msg_wait",
		label: "Wait for a message",
		description: [
			"Block until another agent session messages you, and get the message as this tool's result.",
			'from: only wait for this sender: "parent", "children" (any child: its question, its final report when it ends, or a notice that it died), a folder, or a session id, name or id prefix. Other messages are delivered as usual meanwhile.',
			`timeout_seconds: default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.`,
			"Use it when your next step depends on another session: a go-ahead, a result, an answer, your children finishing. A headless `pi -p` run that ends its turn can't receive anything, so wait instead of finishing early.",
		].join("\n"),
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: 'Only wait for messages from this sender ("parent", "children", a folder, an id or a name)' })),
			timeout_seconds: Type.Optional(Type.Number({ description: `How long to wait (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS})` })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const current = requireLive();
			const timeoutSeconds = clampSeconds(params.timeout_seconds, DEFAULT_WAIT_SECONDS) || DEFAULT_WAIT_SECONDS;
			const filter = waitFilter(current, params.from);
			if (!filter.ok) throw new Error(filter.error);
			const { match, who, id } = filter.value;
			onUpdate?.({ content: toolText(`Waiting up to ${timeoutSeconds}s for a message from ${who}…`), details: { from: id ?? params.from } });
			const waiting = current.waiters.wait(match, timeoutSeconds * 1_000, signal);
			schedulePump(current);
			const outcome = await waiting;
			switch (outcome.kind) {
				case "message": {
					const now = Date.now();
					rememberAwaited(current, outcome.message, now);
					return {
						content: toolText(renderForAgent(outcome.message, now, relationTo(current, outcome.message.from.id))),
						details: { from: id ?? params.from, message: outcome.message, outcome: outcome.kind },
					};
				}
				case "timeout":
					return { content: toolText(`No message from ${who} within ${timeoutSeconds}s.`), details: { from: id ?? params.from, outcome: outcome.kind } };
				case "aborted":
					return { content: toolText("Stopped waiting."), details: { from: id ?? params.from, outcome: outcome.kind } };
			}
		},
	});
}
