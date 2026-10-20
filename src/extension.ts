import { type FSWatcher, watch } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expectation, formatDirectory, headline, replyText, targetLabel } from "./core/format.ts";
import { LIST_ALL, LIST_DESCRIPTION, MAX_WAIT_SECONDS, PROMPT_GUIDELINES, PROMPT_SNIPPET, SEND_DESCRIPTION, SEND_TO } from "./core/guide.ts";
import { DELIVERED_TTL_MS, OFFLINE_TTL_MS, sweepOrphans } from "./core/housekeeping.ts";
import {
	callEnded,
	callStarted,
	endedText,
	noteWords,
	oldestCall,
	relationOf,
	reportWords,
	type RunState,
	stalledAfter,
	startAs,
	type Words,
	wasStopped,
	wordsIn,
} from "./core/lineage.ts";
import { ensureMailbox, pruneDelivered } from "./core/maildir.ts";
import { type Call, type Message, normalizeName, partyLabel, type Relation, renderForAgent } from "./core/message.ts";
import { isValidId, mailboxDirs, msgRoot } from "./core/paths.ts";
import { DEFAULT_WAKE_BUDGET, deliveryAction, outsideBudget, recentWakes, type SessionState, wakeAllowed } from "./core/policy.ts";
import { pumpOnce } from "./core/pump.ts";
import { directory, HEARTBEAT_EVERY_MS, type Mode, pidAlive, type Presence, pruneOffline, readPresence, writePresence } from "./core/registry.ts";
import type { Target } from "./core/resolve.ts";
import { fail, ok, type Result } from "./core/result.ts";
import { canAnswer, findRecipients, type Outgoing, post, postExit, senderOf } from "./core/send.ts";
import { createWaiters, isReplyTo, type Waiters } from "./core/waiters.ts";
import { type ChildWatch, lookAfterChildren, newWatch, type Scope } from "./core/watch.ts";

const CUSTOM_TYPE = "msg";
const STATUS_KEY = "msg";
const TICK_MS = 2_000;
const SCAN_EVERY_MS = HEARTBEAT_EVERY_MS;
/** Two ticks further apart than this mean the process was suspended (the machine slept). */
const WAKE_GAP_MS = 10_000;
const PUMP_DEBOUNCE_MS = 25;
const STARTUP_GRACE_MS = 3_000;
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
	/** The subs this session looks after, and the deaths it already reported. */
	watch: ChildWatch;
	lastScanAt: number;
	lastTickAt: number;
	/** Since when this process has been running without a suspension gap. */
	awakeSince: number;
	/** What the agent last said: the report an `ended` notice carries to the parent. */
	words: Words;
	/** Where the agent's runs stand: an `ended` from a session that goes away mid-run, or after an aborted run, says `stopped`. */
	run: RunState;
	/** The tool calls running that can stall this session, oldest first. The oldest is in its presence, for its parent to judge. */
	calls: readonly Call[];
}

/** How a session stops: `ended` tells its parent (it's over), `quiet` doesn't (a reload, a restart of the same session). */
type Stop = "ended" | "quiet";

type Level = "info" | "warning" | "error";

type ToolText = { type: "text"; text: string };
const toolText = (text: string): ToolText[] => [{ type: "text", text }];

/** pi-web hosts sessions through the SDK in RPC mode; tell it apart so peers know a phone may be watching. */
const hostMode = (mode: ExtensionContext["mode"]): Mode =>
	mode === "rpc" && process.argv.some((arg) => arg.includes("pi-web")) ? "web" : mode;

const clampSeconds = (value: number | undefined): number => Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.round(value ?? 0)));

const withName = (presence: Presence, name: string | undefined): Presence => {
	const { name: _replaced, ...rest } = presence;
	return name ? { ...rest, name } : rest;
};

const withCall = (presence: Presence, call: Call | undefined): Presence => {
	const { call: _replaced, ...rest } = presence;
	return call ? { ...rest, call } : rest;
};

const clipLines = (text: string, max: number): string => {
	const lines = text.split("\n");
	return lines.length <= max ? text : `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines`;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const tell = (ctx: ExtensionContext, text: string, level: Level): void => {
	try {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	} catch {
		// the session is going away; nothing to tell
	}
};

export default function msgExtension(pi: ExtensionAPI): void {
	const root = msgRoot(process.env);
	const home = homedir();
	const stalledAfterMs = stalledAfter(process.env);
	let live: Live | undefined;
	/** Why msg couldn't start in this session, for the tools to explain. */
	let unavailable: string | undefined;
	/** Why this session must not run at all: it was started from a sub's bash. */
	let refused: string | undefined;

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

	const relationTo = (current: Live, senderId: string): Relation | undefined => relationOf(current.presence, senderId, readSafely(senderId));

	/** A sub that ends tells its parent: its whole final message, and whether it was stopped before finishing. */
	const reportEnd = (current: Live, now: number): void => {
		const parent = current.presence.parent;
		if (parent === undefined) return;
		try {
			const stopped = wasStopped(current.run);
			const text = endedText(reportWords(current.words, stopped), current.id);
			const posted = postExit(root, senderOf(current.presence), parent, { kind: "ended", stopped }, text, now);
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
		savePresence(current, { ...withCall(current.presence, undefined), activity: "idle", endedAt: now });
	};

	/** Keeps the running calls; the presence record changes only when the oldest one does. */
	const trackCalls = (current: Live, calls: readonly Call[]): void => {
		const before = oldestCall(current.calls);
		current.calls = calls;
		const oldest = oldestCall(calls);
		if (oldest?.id !== before?.id) savePresence(current, withCall(current.presence, oldest));
	};

	/** Throws once pi has disposed the session (pi-web disposes without session_shutdown). */
	const sessionState = (current: Live, now: number, exempt = false): SessionState => ({
		mode: current.mode,
		idle: current.ctx.isIdle(),
		streaming: current.ctx.signal !== undefined,
		wakeAllowed: exempt || wakeAllowed(current.wakes, now, DEFAULT_WAKE_BUDGET),
	});

	const accepting = (current: Live): boolean => {
		if (current.waiters.size() > 0) return true;
		const now = Date.now();
		const state = sessionState(current, now);
		if (state.idle && now - current.startedAt < STARTUP_GRACE_MS) return false;
		return deliveryAction(state).kind !== "hold";
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
		const subs = dir.live.filter((record) => record.parent === current.id).length;
		const text = [`✉ ${partyLabel(current.presence)}`, ...(subs > 0 ? [`${subs} subs`] : []), ...(peers > 0 ? [`${peers} live`] : [])].join(" · ");
		if (text === current.status) return;
		current.status = text;
		current.ctx.ui.setStatus(STATUS_KEY, text);
	};

	const inject = (current: Live, message: Message): "delivered" | "held" => {
		const now = Date.now();
		const relation = relationTo(current, message.from.id);
		const exempt = outsideBudget(message, relation);
		const action = deliveryAction(sessionState(current, now, exempt));
		const content = renderForAgent(message, now, relation);
		const custom = { customType: CUSTOM_TYPE, content, display: true, details: message };
		switch (action.kind) {
			case "hold":
				return "held";
			case "append":
				pi.sendMessage(custom, { triggerTurn: false });
				rememberAwaited(current, message, now);
				tell(current.ctx, `msg: ${partyLabel(message.from)} wrote, but this session woke ${DEFAULT_WAKE_BUDGET.max}x without you; not waking it again until you prompt`, "warning");
				return "delivered";
			case "inject":
				pi.sendMessage(custom, { triggerTurn: true, deliverAs: "steer" });
				rememberAwaited(current, message, now);
				if (action.wakes && !exempt) current.wakes = [...recentWakes(current.wakes, now, DEFAULT_WAKE_BUDGET), now];
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
			if (report.invalid.length > 0) tell(current.ctx, `msg: skipped ${report.invalid.length} unreadable message file(s)`, "warning");
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
	 * Looks after the subs: every record on a full look, else only new and outdated ones. A sub that went
	 * offline without ending gets a `died` notice in our own inbox, delivered like any message. Returns the records read.
	 */
	const watchFamily = (current: Live, now: number, scope: Scope): readonly Presence[] => {
		try {
			const look = lookAfterChildren(root, current.id, current.watch, scope, now, current.awakeSince, pidAlive, stalledAfterMs);
			current.watch = look.watch;
			for (const { child, kind, error } of look.failed) console.error(`[msg] could not record that ${partyLabel(child)} ${kind}: ${error}`);
			return look.records;
		} catch {
			return [];
		}
	};

	const scan = (current: Live, now: number): readonly Presence[] => {
		current.lastScanAt = now;
		const records = watchFamily(current, now, "full");
		try {
			updateStatus(current, records, now);
		} catch {
			// a status line is cosmetic
		}
		return records;
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
		else watchFamily(current, now, "quick");
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

	const begin = (ctx: ExtensionContext, id: string, mode: Mode, parent: string | undefined): void => {
		if (!isValidId(id)) throw new Error(`session id ${JSON.stringify(id)} can't name a mailbox`);
		ensureMailbox(root, id);
		const now = Date.now();
		const name = normalizeName(pi.getSessionName());
		const idle = ctx.isIdle();
		const presence: Presence = {
			v: 1,
			id,
			...(name ? { name } : {}),
			...(parent ? { parent } : {}),
			cwd: ctx.cwd,
			pid: process.pid,
			mode,
			activity: idle ? "idle" : "busy",
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
			watch: newWatch(),
			lastScanAt: 0,
			lastTickAt: now,
			awakeSince: now,
			words: wordsIn(ctx.sessionManager.getBranch()),
			run: idle ? "none" : "running",
			calls: [],
		};
		live = current;
		current.watcher = watchInbox(current);
		scan(current, now);
		housekeeping(id, now);
	};

	/** A pi started from a sub's bash: say why on stderr and as a notice, and stop before it does any work. */
	const refuse = (ctx: ExtensionContext, reason: string): void => {
		refused = reason;
		console.error(`[msg] ${reason}`);
		tell(ctx, reason, "error");
		if (ctx.mode === "print" || ctx.mode === "json") process.exitCode = 1;
		ctx.shutdown();
	};

	const start = (ctx: ExtensionContext): void => {
		const id = ctx.sessionManager.getSessionId();
		stop(live !== undefined && live.id !== id ? "ended" : "quiet");
		unavailable = undefined;
		refused = undefined;
		const mode = hostMode(ctx.mode);
		const plan = startAs(process.env, id, mode, readSafely);
		if (plan.kind === "refuse") {
			refuse(ctx, plan.reason);
			return;
		}
		try {
			begin(ctx, id, mode, plan.parent);
		} catch (error) {
			stop("quiet");
			unavailable = `msg can't use its store at ${root}: ${errorText(error)}. Point PI_MSG_DIR at a folder this session can write.`;
			console.error(`[msg] ${unavailable}`);
		}
	};

	const requireLive = (): Live => {
		if (live) return live;
		throw new Error(refused ?? unavailable ?? "msg is not running in this session (it starts with the session; try again in a moment)");
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
	pi.on("input", (event, ctx) => {
		if (refused !== undefined) {
			tell(ctx, refused, "error");
			return { action: "handled" as const };
		}
		if (event.source !== "extension" && live) live.wakes = [];
		return undefined;
	});
	pi.on("agent_start", (_event, ctx) => {
		if (refused !== undefined) ctx.abort();
		else if (live) live.run = "running";
	});
	pi.on("agent_settled", (event) => {
		if (!live) return;
		live.run = event.aborted ? "aborted" : "finished";
		trackCalls(live, []);
	});
	pi.on("message_end", (event) => {
		if (live) live.words = noteWords(live.words, event.message);
	});
	pi.on("tool_execution_start", (event) => {
		if (live) trackCalls(live, callStarted(live.calls, event, Date.now()));
	});
	pi.on("tool_execution_end", (event) => {
		if (live) trackCalls(live, callEnded(live.calls, event.toolCallId));
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

	pi.registerTool({
		name: "msg_list",
		label: "Message peers",
		description: LIST_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: [...PROMPT_GUIDELINES],
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({ description: LIST_ALL })),
		}),
		async execute(_toolCallId, params) {
			const current = requireLive();
			const now = Date.now();
			const dir = directory(scan(current, now), now);
			const text = formatDirectory(dir, current.presence, now, home, { all: params.all === true, maxOffline: MAX_OFFLINE_LISTED });
			return { content: toolText(text), details: { live: dir.live.length, offline: dir.offline.length } };
		},
	});

	pi.registerTool({
		name: "msg_send",
		label: "Message a session",
		description: SEND_DESCRIPTION,
		parameters: Type.Object({
			to: Type.String({ description: SEND_TO }),
			message: Type.String({ description: "The message text" }),
			reply_to: Type.Optional(Type.String({ description: "Id of the message you are answering" })),
			wait_seconds: Type.Optional(Type.Number({ description: `Block up to this long for a reply (max ${MAX_WAIT_SECONDS})` })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const current = requireLive();
			const requestedWait = clampSeconds(params.wait_seconds);
			const now = Date.now();
			const recipients = findRecipients(root, current.presence, params.to, now);
			if (!recipients.ok) throw new Error(recipients.error);
			const targets = recipients.value;
			const [single] = targets;
			const waitSeconds = targets.length === 1 && single && canAnswer(single) ? requestedWait : 0;
			const replyTo = params.reply_to?.trim();
			const sent = sendAll(
				current,
				targets,
				{ text: params.message, ...(replyTo ? { replyTo } : {}), ...(waitSeconds > 0 ? { awaitingUntil: now + waitSeconds * 1_000 } : {}) },
				now,
			);
			if (!sent.ok) throw new Error(sent.error);
			const lines = sent.value.map(({ target, message }) => {
				const unblocks = takeAwaited(current, message.replyTo, target.id, now);
				const when = unblocks ? "it is blocked waiting for this reply and gets it right away" : expectation(target, now);
				return `Sent ${message.id} to ${targetLabel(target)}: ${when}.`;
			});
			const [first] = sent.value;
			if (!first) throw new Error("nobody to send to");
			if (sent.value.length > 1) {
				const note = requestedWait > 0 ? "\nNot waiting on a group: their replies wake you." : "";
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
				content: toolText(`${summary}\n${replyText(outcome, who, waitSeconds)}`),
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
}
