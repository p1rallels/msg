import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export const ensureDir = (path: string): string => {
	mkdirSync(path, { recursive: true, mode: DIR_MODE });
	return path;
};

const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;

export const isMissing = (error: unknown): boolean => errorCode(error) === "ENOENT";

/** `.<target>.<writer pid>.<random>.tmp`: the pid tells a sweeper whether the writer is still around. */
const tmpName = (target: string): string =>
	`.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

const TMP_PATTERN = /^\..+\.(\d+)\.[0-9a-f]{8}\.tmp$/;

export const tmpWriterPid = (name: string): number | undefined => {
	const pid = TMP_PATTERN.exec(name)?.[1];
	return pid === undefined ? undefined : Number(pid);
};

const writeAndSync = (path: string, data: string, durable: boolean): void => {
	const fd = openSync(path, "wx", FILE_MODE);
	try {
		writeSync(fd, data);
		if (durable) fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
};

const syncDir = (dir: string): void => {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// not every platform lets you fsync a directory; the file itself is already synced
	}
};

export interface WriteOptions {
	/** Same-volume directory for the temp file; defaults to the target's directory. */
	readonly tmpDir?: string;
	/** fsync the file before the rename and the directory after it, so a power cut can't lose it. */
	readonly durable?: boolean;
}

/** Writes through a temp file and renames into place: readers see the old file or the whole new one. */
export const writeFileAtomic = (target: string, data: string, options: WriteOptions = {}): void => {
	const tmpDir = options.tmpDir ?? dirname(target);
	ensureDir(dirname(target));
	ensureDir(tmpDir);
	const tmp = join(tmpDir, tmpName(target));
	try {
		writeAndSync(tmp, data, options.durable === true);
		renameSync(tmp, target);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
	if (options.durable) syncDir(dirname(target));
};

const mtimeOrUndefined = (path: string): number | undefined => {
	try {
		return statSync(path).mtimeMs;
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
};

/**
 * Deletes temp files a writer left behind when it died between write and rename: its pid is gone,
 * or the file is older than `maxAgeMs` (pids get reused). Returns how many went.
 */
export const sweepTmp = (dir: string, now: number, writerAlive: (pid: number) => boolean, maxAgeMs: number): number => {
	const orphans = readdirOrEmpty(dir).filter((name) => {
		const pid = tmpWriterPid(name);
		if (pid === undefined) return false;
		if (!writerAlive(pid)) return true;
		const mtime = mtimeOrUndefined(join(dir, name));
		return mtime !== undefined && now - mtime > maxAgeMs;
	});
	for (const name of orphans) rmSync(join(dir, name), { force: true });
	return orphans.length;
};

export const readTextOrUndefined = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
};

export const readdirOrEmpty = (dir: string): string[] => {
	try {
		return readdirSync(dir);
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
};

export const listJsonFiles = (dir: string): string[] =>
	readdirOrEmpty(dir)
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.sort();

export const listDirs = (dir: string): string[] => {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
};

/** Atomic move. Returns false when the source is already gone (someone else moved it first). */
export const moveIfPresent = (from: string, to: string): boolean => {
	try {
		renameSync(from, to);
		return true;
	} catch (error) {
		if (isMissing(error) && !existsSync(from)) return false;
		throw error;
	}
};

export const parseJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
};
