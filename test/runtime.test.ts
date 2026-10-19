import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deliver, pending } from "../src/core/maildir.ts";
import type { Message } from "../src/core/message.ts";
import { DEFAULT_WAKE_BUDGET, deliveryAction, recentWakes, wakeAllowed } from "../src/core/policy.ts";
import { pumpOnce } from "../src/core/pump.ts";
import { createWaiters, isFrom, isFromChildOf, isReplyTo } from "../src/core/waiters.ts";
import { message, tempRoot } from "./helpers.ts";

describe("waiters", () => {
	test("the oldest matching waiter takes an offered message", async () => {
		const waiters = createWaiters();
		const first = waiters.wait(() => true, 1_000);
		const second = waiters.wait(() => true, 1_000);
		const sent = message({ to: "me" });
		expect(waiters.offer(sent)).toBe(true);
		expect(await first).toEqual({ kind: "message", message: sent });
		expect(waiters.size()).toBe(1);
		waiters.cancelAll();
		expect(await second).toEqual({ kind: "aborted" });
		expect(waiters.size()).toBe(0);
	});

	test("nobody wants it: offer returns false", () => {
		const waiters = createWaiters();
		void waiters.wait(() => false, 50);
		expect(waiters.offer(message({ to: "me" }))).toBe(false);
		waiters.cancelAll();
	});

	test("times out and cleans up", async () => {
		const waiters = createWaiters();
		expect(await waiters.wait(() => true, 5)).toEqual({ kind: "timeout" });
		expect(waiters.size()).toBe(0);
	});

	test("abort signal settles it, already-aborted settles at once", async () => {
		const waiters = createWaiters();
		const controller = new AbortController();
		const waiting = waiters.wait(() => true, 10_000, controller.signal);
		controller.abort();
		expect(await waiting).toEqual({ kind: "aborted" });
		expect(await waiters.wait(() => true, 10_000, controller.signal)).toEqual({ kind: "aborted" });
		expect(waiters.size()).toBe(0);
	});

	test("isReplyTo: from the recipient, pointing at the message or at nothing", () => {
		const sent = message({ to: "bob", from: { id: "alice" } });
		const match = isReplyTo(sent);
		expect(match(message({ to: "alice", from: { id: "bob" }, replyTo: sent.id }))).toBe(true);
		expect(match(message({ to: "alice", from: { id: "bob" } }))).toBe(true);
		expect(match(message({ to: "alice", from: { id: "bob" }, replyTo: "000000000-other0" }))).toBe(false);
		expect(match(message({ to: "alice", from: { id: "carol" }, replyTo: sent.id }))).toBe(false);
	});

	test("isReplyTo: a recipient that ends or dies instead of replying unblocks the sender too", () => {
		const sent = message({ to: "kid", from: { id: "boss" } });
		expect(isReplyTo(sent)(message({ to: "boss", from: { id: "kid" }, kind: "ended" }))).toBe(true);
		expect(isReplyTo(sent)(message({ to: "boss", from: { id: "kid" }, kind: "died" }))).toBe(true);
	});

	test("isFromChildOf: whoever's record names me as parent when the message arrives", () => {
		const parents: Record<string, string> = { "kid-1": "boss", "kid-2": "other" };
		const match = isFromChildOf("boss", (id) => parents[id]);
		expect(match(message({ to: "boss", from: { id: "kid-1" } }))).toBe(true);
		expect(match(message({ to: "boss", from: { id: "kid-2" } }))).toBe(false);
		expect(match(message({ to: "boss", from: { id: "stranger" } }))).toBe(false);
		parents["late-kid"] = "boss";
		expect(match(message({ to: "boss", from: { id: "late-kid" }, kind: "died" }))).toBe(true);
	});

	test("isFrom: anyone when unset", () => {
		expect(isFrom(undefined)(message({ to: "x" }))).toBe(true);
		expect(isFrom("sender-1")(message({ to: "x" }))).toBe(true);
		expect(isFrom("other")(message({ to: "x" }))).toBe(false);
	});
});

describe("deliveryAction", () => {
	test("running sessions get it steered or queued, never woken", () => {
		expect(deliveryAction({ mode: "print", idle: false, streaming: true, wakeAllowed: false }, "steer")).toEqual({ kind: "inject", deliverAs: "steer", wakes: false });
		expect(deliveryAction({ mode: "tui", idle: false, streaming: true, wakeAllowed: true }, "followUp")).toEqual({ kind: "inject", deliverAs: "followUp", wakes: false });
	});

	test("busy but not streaming (compacting, run still starting) holds it for the next pump", () => {
		expect(deliveryAction({ mode: "tui", idle: false, streaming: false, wakeAllowed: true }, "steer").kind).toBe("hold");
	});

	test("idle print/json runs hold it; they'd break if a message started a run", () => {
		expect(deliveryAction({ mode: "print", idle: true, streaming: false, wakeAllowed: true }, "steer").kind).toBe("hold");
		expect(deliveryAction({ mode: "json", idle: true, streaming: false, wakeAllowed: true }, "steer").kind).toBe("hold");
	});

	test("idle interactive sessions wake, unless the wake budget is spent", () => {
		expect(deliveryAction({ mode: "web", idle: true, streaming: false, wakeAllowed: true }, "steer")).toEqual({ kind: "inject", deliverAs: "steer", wakes: true });
		expect(deliveryAction({ mode: "tui", idle: true, streaming: false, wakeAllowed: false }, "steer").kind).toBe("append");
	});

	test("wake budget counts only wakes inside the window", () => {
		const budget = { max: 2, windowMs: 100 };
		expect(recentWakes([0, 50, 120], 149, budget)).toEqual([50, 120]);
		expect(wakeAllowed([50, 120], 149, budget)).toBe(false);
		expect(wakeAllowed([50, 120], 150, budget)).toBe(true);
		expect(DEFAULT_WAKE_BUDGET.max).toBeGreaterThan(5);
	});
});

describe("pumpOnce", () => {
	let root = "";
	let cleanup = () => {};
	beforeEach(() => {
		({ root, cleanup } = tempRoot());
	});
	afterEach(() => cleanup());

	const seed = (count: number): Message[] =>
		Array.from({ length: count }, (_, index) => {
			const item = message({ to: "me", text: `m${index}` }, 1_000 + index);
			deliver(root, item);
			return item;
		});

	test("delivers oldest first and empties the inbox", () => {
		seed(3);
		const seen: string[] = [];
		const report = pumpOnce(root, "me", { accepting: () => true, offer: () => false, deliver: (m) => (seen.push(m.text), "delivered") });
		expect(seen).toEqual(["m0", "m1", "m2"]);
		expect(report.delivered.length).toBe(3);
		expect(pending(root, "me")).toEqual([]);
	});

	test("waiters get first pick", () => {
		seed(2);
		const seen: string[] = [];
		const report = pumpOnce(root, "me", { accepting: () => true, offer: (m) => m.text === "m0", deliver: (m) => (seen.push(m.text), "delivered") });
		expect(report.offered.map((m) => m.text)).toEqual(["m0"]);
		expect(seen).toEqual(["m1"]);
	});

	test("not accepting leaves everything pending", () => {
		seed(2);
		const report = pumpOnce(root, "me", { accepting: () => false, offer: () => false, deliver: () => "delivered" });
		expect(report.delivered).toEqual([]);
		expect(pending(root, "me").length).toBe(2);
	});

	test("a failed delivery puts the message back and stops", () => {
		seed(3);
		const report = pumpOnce(root, "me", {
			accepting: () => true,
			offer: () => false,
			deliver: (m) => {
				if (m.text === "m1") throw new Error("session gone");
				return "delivered";
			},
		});
		expect(report.delivered.map((m) => m.text)).toEqual(["m0"]);
		expect(String(report.failure)).toContain("session gone");
		expect(pending(root, "me").length).toBe(2);
	});

	test("held puts the message back and stops without a failure", () => {
		seed(2);
		const report = pumpOnce(root, "me", { accepting: () => true, offer: () => false, deliver: () => "held" });
		expect(report.delivered).toEqual([]);
		expect(report.failure).toBeUndefined();
		expect(pending(root, "me").length).toBe(2);
	});
});
