import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pending } from "../src/core/maildir.ts";
import { createMessage, type Draft, type Message, parseMessage } from "../src/core/message.ts";
import { mailboxDirs } from "../src/core/paths.ts";
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
				...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
				...(draft.awaitingUntil !== undefined ? { awaitingUntil: draft.awaitingUntil } : {}),
				...(draft.kind ? { kind: draft.kind } : {}),
				...(draft.stopped ? { stopped: true } : {}),
				...(draft.life ? { life: draft.life } : {}),
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

/** The messages waiting in `id`'s new/, oldest first, without claiming them. */
export const waiting = (root: string, id: string): Message[] =>
	pending(root, id).map((file) => unwrap(parseMessage(JSON.parse(readFileSync(join(mailboxDirs(root, id).new, file), "utf8")))));
