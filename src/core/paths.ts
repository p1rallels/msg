import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const isValidId = (id: string): boolean => ID_PATTERN.test(id) && !id.includes("..");

export const assertValidId = (id: string): string => {
	if (isValidId(id)) return id;
	throw new Error(`invalid id ${JSON.stringify(id)}: use letters, digits, '.', '_' or '-' (max 128)`);
};

const expandHome = (path: string, home: string): string => {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
};

const nonEmpty = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
};

export const agentDir = (env: Env, home: string = homedir()): string => {
	const configured = nonEmpty(env.PI_CODING_AGENT_DIR);
	return configured ? expandHome(configured, home) : join(home, ".pi", "agent");
};

export const msgRoot = (env: Env, home: string = homedir()): string => {
	const configured = nonEmpty(env.PI_MSG_DIR);
	return configured ? expandHome(configured, home) : join(agentDir(env, home), "msg");
};

/** The folder with symlinks resolved, or just normalized when it doesn't exist. */
export const canonicalPath = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};

export const sessionsDir = (root: string): string => join(root, "sessions");

export const presencePath = (root: string, id: string): string => join(sessionsDir(root), `${assertValidId(id)}.json`);

export interface MailboxDirs {
	readonly tmp: string;
	readonly new: string;
	readonly cur: string;
}

export const inboxesDir = (root: string): string => join(root, "inbox");

export const mailboxDirs = (root: string, id: string): MailboxDirs => {
	const base = join(inboxesDir(root), assertValidId(id));
	return { tmp: join(base, "tmp"), new: join(base, "new"), cur: join(base, "cur") };
};
