import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { callGroup, etimeMs, groupStopCommand, namesGroupStop, parseProcs, type ProcRow, psTable, START_SLACK_MS } from "../src/core/group.ts";
import { pidAlive } from "../src/core/registry.ts";

const SUB = 4242;
const now = 1_700_000_000_000;
const since = now - 12 * 60_000;
/** A process started `startedAt`, as ps would list it at `now` (whole seconds of elapsed time). */
const row = (pid: number, ppid: number, pgid: number, startedAt: number): ProcRow => ({ pid, ppid, pgid, elapsedMs: Math.floor((now - startedAt) / 1_000) * 1_000 });

describe("ps's elapsed time", () => {
	test("mm:ss, hh:mm:ss and dd-hh:mm:ss", () => {
		expect(etimeMs("00:05")).toBe(5_000);
		expect(etimeMs("12:01")).toBe(721_000);
		expect(etimeMs("01:02:03")).toBe(3_723_000);
		expect(etimeMs("2-01:02:03")).toBe((2 * 86_400 + 3_723) * 1_000);
		expect(etimeMs("01-13:35:34")).toBe((86_400 + 13 * 3_600 + 35 * 60 + 34) * 1_000);
		expect(etimeMs("123-00:00:00")).toBe(123 * 86_400_000);
	});

	test("anything else is none", () => {
		for (const junk of ["", " ", "5", "05", "1:2:3:4", "2-03:04", "-01:02", "ab:cd", "01:02 ", "01:-2", "ELAPSED", "1.5:00"]) expect([junk, etimeMs(junk)]).toEqual([junk, undefined]);
	});
});

describe("parsing ps -A -o pid=,ppid=,pgid=,etime=", () => {
	test("rows as macOS and Linux print them, right-aligned", () => {
		const output = ["    1     0     1 01-13:35:34", "  731     1   731    02:11:09", "48211 48190 48211       00:07", ""].join("\n");
		expect(parseProcs(output)).toEqual([
			{ pid: 1, ppid: 0, pgid: 1, elapsedMs: (86_400 + 13 * 3_600 + 35 * 60 + 34) * 1_000 },
			{ pid: 731, ppid: 1, pgid: 731, elapsedMs: (2 * 3_600 + 11 * 60 + 9) * 1_000 },
			{ pid: 48211, ppid: 48190, pgid: 48211, elapsedMs: 7_000 },
		]);
	});

	test("garbage lines are skipped, the rows around them kept", () => {
		const output = [
			"  PID  PPID  PGID ELAPSED",
			"ps: some process vanished",
			"  12    1   12",
			"  13    1   13  00:01  extra",
			"  -4    1    4  00:01",
			"  14    1   14  soon",
			"\t15\t1\t15\t00:02\r",
			"  16    1   16  00:03",
		].join("\n");
		expect(parseProcs(output).map((proc) => proc.pid)).toEqual([15, 16]);
		expect(parseProcs("")).toEqual([]);
	});
});

describe("the group a sub's bash call runs in", () => {
	const shell = (pid: number, startedAt = since + 40) => row(pid, SUB, pid, startedAt);

	test("one match: the sub's direct child that leads its own group, started with the call", () => {
		const rows = [row(SUB, 900, 900, now - 3_600_000), shell(5001), row(5002, 5001, 5001, since + 60), row(777, 1, 777, since + 40)];
		expect(callGroup(rows, SUB, since, now)).toBe(5001);
	});

	test("two leaders started in the same second: no group", () => {
		expect(callGroup([shell(5001, since + 10), shell(5003, since + 300)], SUB, since, now)).toBeUndefined();
	});

	test("a matching start whose parent isn't the sub: no group", () => {
		expect(callGroup([row(5001, 4243, 5001, since + 40), row(5004, 1, 5004, since)], SUB, since, now)).toBeUndefined();
	});

	test("a child that doesn't lead its group (not detached): no group", () => {
		expect(callGroup([row(5001, SUB, 900, since + 40)], SUB, since, now)).toBeUndefined();
	});

	test("only a start within the slack counts: an older or younger leader is another call's", () => {
		expect(callGroup([shell(5001, since - 60_000), shell(5005, since + 30_000)], SUB, since, now)).toBeUndefined();
		expect(callGroup([shell(5001, since - 60_000), shell(5005, since + 30_000), shell(5006)], SUB, since, now)).toBe(5006);
		expect(callGroup([{ pid: 5007, ppid: SUB, pgid: 5007, elapsedMs: now - since + START_SLACK_MS }], SUB, since, now)).toBe(5007);
		expect(callGroup([{ pid: 5007, ppid: SUB, pgid: 5007, elapsedMs: now - since + START_SLACK_MS + 1 }], SUB, since, now)).toBeUndefined();
	});

	test("a call that has run for days and hours is found by its start", () => {
		const longSince = now - (3 * 86_400 + 4 * 3_600) * 1_000;
		const [listed] = parseProcs(`  5008  ${SUB}  5008  3-04:00:00`);
		if (!listed) throw new Error("expected a row");
		expect(callGroup([listed], SUB, longSince, now)).toBe(5008);
		expect(callGroup([listed], SUB, since, now)).toBeUndefined();
	});

	test("never group 0 or 1, never for a sub pid that can't be one", () => {
		expect(callGroup([{ pid: 1, ppid: 0, pgid: 1, elapsedMs: now - since }], 0, since, now)).toBeUndefined();
		expect(callGroup([{ pid: 1, ppid: SUB, pgid: 1, elapsedMs: now - since }], SUB, since, now)).toBeUndefined();
		for (const pid of [-1, 0, 1, 1.5, Number.NaN]) expect(callGroup([shell(5001)], pid, since, now)).toBeUndefined();
	});

	test("nothing listed: no group", () => {
		expect(callGroup([], SUB, since, now)).toBeUndefined();
	});
});

describe("the command's own stop", () => {
	test("kill -- -<pgid>: SIGTERM to the whole group", () => {
		expect(groupStopCommand(5001)).toBe("kill -- -5001");
	});

	test("namesGroupStop: a notice that names one, quoted as msg writes it", () => {
		expect(namesGroupStop("To stop just that command, run `kill -- -5001` (its process group)")).toBe(true);
		expect(namesGroupStop("To stop it, run `kill 4242`: pi kills the commands")).toBe(false);
		expect(namesGroupStop("kill -- -5001")).toBe(false);
	});
});

describe("on this machine", () => {
	test("ps lists this process, its parent and its group", () => {
		const rows = psTable();
		const self = rows?.find((proc) => proc.pid === process.pid);
		expect(self?.ppid).toBe(process.ppid);
		expect(self?.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	test("a detached child, as pi spawns a bash command, is found as the group of a call that started with it", async () => {
		const startedAt = Date.now();
		const child = spawn("sleep", ["37"], { detached: true, stdio: "ignore" });
		try {
			const pid = child.pid ?? 0;
			const rows = psTable() ?? [];
			expect(rows.find((proc) => proc.pid === pid)).toMatchObject({ ppid: process.pid, pgid: pid });
			expect(callGroup(rows, process.pid, startedAt, Date.now())).toBe(pid);
			process.kill(-pid, "SIGTERM");
			await new Promise((done) => child.once("exit", done));
			expect(pidAlive(pid)).toBe(false);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	});
});
