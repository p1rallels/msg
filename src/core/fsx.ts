import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

const tmpName = (target: string): string =>
	`.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

/** Writes through a sibling temp file (or `tmpDir`, which must be on the same volume) and renames into place. */
export const writeFileAtomic = (target: string, data: string, tmpDir: string = dirname(target)): void => {
	ensureDir(dirname(target));
	ensureDir(tmpDir);
	const tmp = join(tmpDir, tmpName(target));
	try {
		writeFileSync(tmp, data, { mode: FILE_MODE });
		renameSync(tmp, target);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
};

export const readTextOrUndefined = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
};

export const listJsonFiles = (dir: string): string[] => {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".json") && !name.startsWith("."))
			.sort();
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
};

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
