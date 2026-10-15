import type { Delivery } from "./message.ts";
import type { Mode } from "./registry.ts";

export type DeliveryAction =
	/** Into the conversation: steered or queued into the active run, or starting a run when idle. */
	| { readonly kind: "inject"; readonly deliverAs: Delivery; readonly wakes: boolean }
	/** Into the conversation without starting a run: the agent sees it on its next turn. */
	| { readonly kind: "append" }
	/** Leave it in the inbox for later. */
	| { readonly kind: "hold" };

export interface SessionState {
	readonly mode: Mode;
	/** No run, compaction or queued continuation. */
	readonly idle: boolean;
	/** The agent loop is running, so a message can be steered or queued into it. */
	readonly streaming: boolean;
	readonly wakeAllowed: boolean;
}

/**
 * Print and JSON runs take their prompt after the session starts and exit when it settles, so a
 * message must never start a run there: it only joins a run that's already going. A session busy
 * with something other than its agent loop (a manual compaction, a run still starting) holds the
 * message for the next pump instead of starting a second run.
 */
export const deliveryAction = (state: SessionState, delivery: Delivery): DeliveryAction => {
	if (!state.idle) return state.streaming ? { kind: "inject", deliverAs: delivery, wakes: false } : { kind: "hold" };
	if (state.mode === "print" || state.mode === "json") return { kind: "hold" };
	if (!state.wakeAllowed) return { kind: "append" };
	return { kind: "inject", deliverAs: delivery, wakes: true };
};

export interface WakeBudget {
	readonly max: number;
	readonly windowMs: number;
}

export const DEFAULT_WAKE_BUDGET: WakeBudget = { max: 20, windowMs: 10 * 60_000 };

/** Wakes inside the window. Two agents that keep answering each other run out; a human prompt resets it. */
export const recentWakes = (wakes: readonly number[], now: number, budget: WakeBudget): number[] =>
	wakes.filter((at) => now - at < budget.windowMs);

export const wakeAllowed = (wakes: readonly number[], now: number, budget: WakeBudget): boolean =>
	recentWakes(wakes, now, budget).length < budget.max;
