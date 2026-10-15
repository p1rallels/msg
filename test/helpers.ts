import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessage, type Draft, type Message } from "../src/core/message.ts";
import type { Presence } from "../src/core/registry.ts";
import { unwrap } from "../src/core/result.ts";

export const tempRoot = (): { root: string; cleanup: () => void } => {
	const root = mkdtempSync(join(tmpdir(), "msg-test-"));
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

let counter = 0;
export const fixedRandom = (bytes: number): string => (counter++).toString(16).padStart(bytes * 2, "0").slice(-bytes * 2);

export const message = (draft: Partial<Draft> & { to: string }, now = 1_700_000_000_000): Message =>
	unwrap(
		createMessage(
			{
				from: draft.from ?? { id: "sender-1", name: "sender" },
				to: draft.to,
				text: draft.text ?? "hello",
				...(draft.delivery ? { delivery: draft.delivery } : {}),
				...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
				...(draft.awaitingUntil !== undefined ? { awaitingUntil: draft.awaitingUntil } : {}),
			},
			now,
			fixedRandom,
		),
	);

export const presence = (overrides: Partial<Presence> & { id: string }): Presence => ({
	v: 1,
	cwd: "/tmp/project",
	pid: 4242,
	mode: "tui",
	activity: "idle",
	startedAt: 1_000,
	heartbeatAt: 10_000,
	...overrides,
});
