import { listDirs, sweepTmp } from "./fsx.ts";
import { inboxesDir, isValidId, mailboxDirs, sessionsDir } from "./paths.ts";
import { type PidProbe, pidAlive } from "./registry.ts";

/** A temp file this old is an orphan even if some process now has the writer's pid. */
export const TMP_MAX_AGE_MS = 60 * 60_000;
/** Delivered messages (`cur/`) older than this go at session start. */
export const DELIVERED_TTL_MS = 7 * 24 * 60 * 60_000;
/** Presence records nobody has seen for this long go at session start. */
export const OFFLINE_TTL_MS = 30 * 24 * 60 * 60_000;

/** Removes temp files from writers that died mid-write, across the registry and every inbox. */
export const sweepOrphans = (root: string, now: number, probe: PidProbe = pidAlive): number =>
	[sessionsDir(root), ...listDirs(inboxesDir(root)).filter(isValidId).map((id) => mailboxDirs(root, id).tmp)]
		.map((dir) => sweepTmp(dir, now, probe, TMP_MAX_AGE_MS))
		.reduce((total, swept) => total + swept, 0);
