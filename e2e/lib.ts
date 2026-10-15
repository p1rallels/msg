import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { listPresence, type Presence } from "../src/core/registry.ts";

export const REPO = resolve(import.meta.dir, "..");
export const EXTENSION = join(REPO, "src/extension.ts");
export const CLI = join(REPO, "src/cli.ts");
export const MODEL = process.env.E2E_MODEL ?? "anthropic/claude-haiku-5-5";
export const THINKING = process.env.E2E_THINKING ?? "low";

export interface World {
	readonly store: string;
	readonly sessions: string;
	readonly env: Record<string, string>;
	/** Processes to kill when the scenario ends, however it ends. */
	readonly children: Subprocess[];
	readonly dispose: () => void;
}

/** A private store and session dir, so the scenario never touches the real ~/.pi. */
export const world = (label: string): World => {
	const base = mkdtempSync(join(tmpdir(), `msg-e2e-${label}-`));
	const store = join(base, "store");
	const sessions = join(base, "sessions");
	mkdirSync(store, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	const children: Subprocess[] = [];
	return {
		store,
		sessions,
		env: { ...env, PI_MSG_DIR: store },
		children,
		dispose: () => {
			for (const child of children) if (child.exitCode === null) child.kill();
			if (process.env.E2E_KEEP) console.log(`kept ${base}`);
			else rmSync(base, { recursive: true, force: true });
		},
	};
};

/** pi with only this extension loaded, a cheap model, and sessions kept out of ~/.pi. */
export const piArgs = (w: World, name: string, extra: readonly string[]): string[] => [
	"pi",
	"--no-extensions",
	"--no-skills",
	"-e",
	EXTENSION,
	"--name",
	name,
	"--model",
	MODEL,
	"--thinking",
	THINKING,
	"--session-dir",
	w.sessions,
	...extra,
];

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export const waitUntil = async <T>(what: string, probe: () => T | undefined, timeoutMs: number, everyMs = 200): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
		await sleep(everyMs);
	}
};

export const presenceNamed = (w: World, name: string): Presence | undefined =>
	listPresence(w.store).find((record) => record.name === name && record.endedAt === undefined);

export interface CliResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export const cli = async (w: World, args: readonly string[], env: Record<string, string> = {}): Promise<CliResult> => {
	const proc = Bun.spawn(["bun", CLI, ...args], { env: { ...w.env, ...env }, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
};

export interface Run {
	readonly proc: Subprocess<"pipe", "pipe", "pipe">;
	readonly done: Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Starts pi in the scenario's world. stdin is a pipe: RPC mode reads commands from it, and
 * print mode waits for its EOF before prompting, so `-p` runs get it closed right away.
 */
export const spawnPi = (w: World, args: readonly string[], cwd = REPO): Run => {
	const proc = Bun.spawn(args as string[], { cwd, env: w.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	w.children.push(proc);
	if (!args.includes("rpc")) proc.stdin.end();
	const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({
		code,
		stdout,
		stderr,
	}));
	return { proc, done };
};

/** Session file lines of the session with this id (pi files them flat into --session-dir). */
export const sessionEntries = (w: World, id: string): Record<string, unknown>[] => {
	const glob = new Bun.Glob(`*${id}*.jsonl`);
	const [file] = [...glob.scanSync(w.sessions)];
	if (!file) return [];
	return readFileSync(join(w.sessions, file), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
};

export const toolCalls = (entries: readonly Record<string, unknown>[], tool: string): unknown[] =>
	entries.flatMap((entry) => {
		const message = entry.message as { role?: string; content?: { type?: string; name?: string; arguments?: unknown }[] } | undefined;
		if (entry.type !== "message" || message?.role !== "assistant") return [];
		return (message.content ?? []).filter((part) => part.type === "toolCall" && part.name === tool).map((part) => part.arguments);
	});

export const customMessages = (entries: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
	entries.filter((entry) => entry.type === "custom_message" && entry.customType === "msg");

export interface Check {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}

export const check = (name: string, ok: boolean, detail?: string): Check => ({ name, ok, ...(detail ? { detail } : {}) });

export const report = (scenario: string, checks: readonly Check[]): boolean => {
	const passed = checks.every((item) => item.ok);
	console.log(`\n${passed ? "PASS" : "FAIL"} ${scenario}`);
	for (const item of checks) console.log(`  ${item.ok ? "ok  " : "FAIL"} ${item.name}${item.detail ? `\n       ${item.detail.replace(/\n/g, "\n       ")}` : ""}`);
	return passed;
};
