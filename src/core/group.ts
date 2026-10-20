import { spawnSync } from "node:child_process";

/** A process as `ps -A -o pid=,ppid=,pgid=,etime=` lists it: its parent, its process group, and how long it has run. */
export interface ProcRow {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
	readonly elapsedMs: number;
}

/** The machine's processes now, or undefined when they can't be listed (ps failed or took too long). */
export type ProcessTable = () => readonly ProcRow[] | undefined;

const ETIME = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/;

/** ps's elapsed time, `[[dd-]hh:]mm:ss` on macOS and Linux alike, in ms. Undefined when it isn't one. */
export const etimeMs = (text: string): number | undefined => {
	const match = ETIME.exec(text);
	if (!match) return undefined;
	const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
	return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000;
};

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/;

const rowOf = (line: string): ProcRow | undefined => {
	const match = ROW.exec(line);
	const elapsedMs = etimeMs(match?.[4] ?? "");
	if (!match || elapsedMs === undefined) return undefined;
	return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), elapsedMs };
};

/** The processes in `ps -A -o pid=,ppid=,pgid=,etime=` output. A line that isn't one is skipped. */
export const parseProcs = (output: string): ProcRow[] => output.split("\n").flatMap((line) => rowOf(line) ?? []);

/** How far apart a call's start and its shell's may be: ps counts whole seconds, and pi spawns the shell just after the call starts. */
export const START_SLACK_MS = 2_000;

/** The longest msg waits for ps: it runs in the parent's process, pi-web's server for a pi-web parent. */
export const PS_TIMEOUT_MS = 2_000;

/** Lists the machine's processes with `ps`, blocking for at most PS_TIMEOUT_MS. */
export const psTable: ProcessTable = () => {
	try {
		const ran = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,etime="], { encoding: "utf8", timeout: PS_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
		return ran.status === 0 && typeof ran.stdout === "string" ? parseProcs(ran.stdout) : undefined;
	} catch {
		return undefined;
	}
};

const startedNear = (row: ProcRow, since: number, now: number): boolean => Math.abs(now - row.elapsedMs - since) <= START_SLACK_MS;

/**
 * The process group a sub's bash call runs in. pi spawns every bash command `detached`, so the shell it starts for the
 * call is a direct child of the sub's pi that leads a group of its own, started as the call did (`since`). Exactly one
 * such child is the group; none, or more than one, is no group: a wrong one would kill someone else's processes.
 * Groups 0 and 1 are never one (`kill -- -0` is your own group, `kill -- -1` every process you can signal).
 */
export const callGroup = (rows: readonly ProcRow[], subPid: number, since: number, now: number): number | undefined => {
	if (!Number.isSafeInteger(subPid) || subPid <= 1) return undefined;
	const leaders = rows.filter((row) => row.ppid === subPid && row.pid === row.pgid && row.pgid > 1 && startedNear(row, since, now));
	return leaders.length === 1 ? leaders[0]?.pgid : undefined;
};

/** What stops just one command: SIGTERM to its whole process group, the group pi's own timeout would SIGKILL. */
export const groupStopCommand = (pgid: number): string => `kill -- -${pgid}`;

const GROUP_STOP = /`kill -- -\d+`/;

/** True when a notice's text names a command's group stop, so the reader can stop just that command. */
export const namesGroupStop = (text: string): boolean => GROUP_STOP.test(text);
