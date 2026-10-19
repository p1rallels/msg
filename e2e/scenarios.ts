import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "../src/core/message.ts";
import { listPresence, type Presence, readPresence } from "../src/core/registry.ts";
import {
	allSessionText,
	assistantTexts,
	busyNamed,
	type Check,
	check,
	customMessages,
	delivered,
	EXTENSION,
	inboxOf,
	MODEL,
	piArgs,
	presenceNamed,
	REPO,
	report,
	type Run,
	rpc,
	sessionEntries,
	sleep,
	spawnPi,
	THINKING,
	toolCalls,
	toolResults,
	waitUntil,
	type World,
	world,
} from "./lib.ts";

const ONLINE_TIMEOUT_MS = 45_000;
const STARTUP_GRACE_MS = 3_500;

const clip = (text: string, max = 600): string => (text.length > max ? `${text.slice(0, max)}…` : text);

const noExtensionErrors = (stderr: string): Check => check("no extension errors", !/\[msg\]|extension.*error/i.test(stderr), clip(stderr));

const ASK_BOB = [
	"You are alice. The agent session named bob can do arithmetic for you.",
	'Ask it with one msg_send: to "bob", message "What is 6 times 7? Answer with just the number.", wait_seconds 120.',
	"Then reply with just bob's answer and nothing else.",
].join(" ");

/** An idle interactive session wakes up for a message, and its answer unblocks the pi -p session that asked. */
export const rpcWake = async (): Promise<boolean> => {
	const w = world("wake");
	const checks: Check[] = [];
	try {
		const bob = spawnPi(w, piArgs(w, "bob", ["--mode", "rpc"]));
		const bobRecord = await waitUntil("bob online", () => presenceNamed(w, "bob"), ONLINE_TIMEOUT_MS);
		await sleep(STARTUP_GRACE_MS);
		const alice = spawnPi(w, piArgs(w, "alice", ["-p", ASK_BOB]));
		const aliceRecord = await waitUntil("alice online", () => presenceNamed(w, "alice"), ONLINE_TIMEOUT_MS);
		const aliceDone = await alice.done;
		bob.proc.stdin.end();
		const bobDone = await bob.done;
		const aliceEntries = sessionEntries(w, aliceRecord.id);
		const bobEntries = sessionEntries(w, bobRecord.id);
		const asks = toolCalls(aliceEntries, "msg_send") as { to?: string; wait_seconds?: number }[];
		const answers = toolCalls(bobEntries, "msg_send") as { to?: string; reply_to?: string }[];
		checks.push(
			check("both are top-level", bobRecord.parent === undefined && aliceRecord.parent === undefined),
			check("alice asked bob by its live name, blocking with wait_seconds", asks.some((args) => args.to === "bob" && (args.wait_seconds ?? 0) > 0), JSON.stringify(asks)),
			check("idle bob woke up for the message", delivered(bobEntries).some(({ message }) => message.from.id === aliceRecord.id)),
			check("bob answered with reply_to", answers.some((args) => Boolean(args.reply_to)), JSON.stringify(answers)),
			check(
				"bob was told alice is blocked on his reply",
				toolResults(bobEntries, "msg_send").some((text) => text.includes("blocked waiting for this reply")),
				toolResults(bobEntries, "msg_send").join("\n"),
			),
			check("bob's answer came back as alice's msg_send result", toolResults(aliceEntries, "msg_send").some((text) => text.includes("bob replied") && /\b42\b/.test(text))),
			check("alice exits 0 with the answer", aliceDone.code === 0 && /\b42\b/.test(aliceDone.stdout), clip(aliceDone.stdout + aliceDone.stderr)),
			check("closing stdin ends bob's presence", readPresence(w.store, bobRecord.id)?.endedAt !== undefined),
			noExtensionErrors(aliceDone.stderr + bobDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("rpc wake: a pi -p session asks an idle rpc session and blocks on msg_send for the answer", checks);
};

const CAROL_TASK = [
	"You are carol. What you know: the secret word is pineapple.",
	"Run the bash command `sleep 40` and wait for it to finish.",
	"Then: if a message from another agent session reached you meanwhile, answer it with one msg_send to the sender's session id with reply_to the message id, and then reply DONE.",
	"If none did, reply NONE.",
].join(" ");

const ASK_CAROL = [
	"You are alice. The agent session named carol knows the secret word.",
	'Ask her for it with one msg_send: to "carol", wait_seconds 180.',
	"Then reply with just the secret word and nothing else.",
].join(" ");

/** A message to a busy pi -p run is steered in at its next step, and its answer unblocks the asker. */
export const steerBusy = async (): Promise<boolean> => {
	const w = world("steer");
	const checks: Check[] = [];
	try {
		const carol = spawnPi(w, piArgs(w, "carol", ["-p", CAROL_TASK]));
		const carolRecord = await waitUntil("carol busy", busyNamed(w, "carol"), ONLINE_TIMEOUT_MS);
		const alice = spawnPi(w, piArgs(w, "alice", ["-p", ASK_CAROL]));
		const aliceRecord = await waitUntil("alice online", () => presenceNamed(w, "alice"), ONLINE_TIMEOUT_MS);
		const [aliceDone, carolDone] = await Promise.all([alice.done, carol.done]);
		const aliceEntries = sessionEntries(w, aliceRecord.id);
		const carolEntries = sessionEntries(w, carolRecord.id);
		const msgIndex = delivered(carolEntries).find(({ message }) => message.from.id === aliceRecord.id)?.index ?? -1;
		const bashIndex = carolEntries.findIndex((entry) => toolCalls([entry], "bash").length > 0);
		const answers = toolCalls(carolEntries, "msg_send") as { reply_to?: string }[];
		checks.push(
			check("alice was told carol is busy", toolResults(aliceEntries, "msg_send").some((text) => text.includes("busy; it sees the message at its next step")), toolResults(aliceEntries, "msg_send").join("\n")),
			check("the message landed in carol mid-run, after her bash call", msgIndex > bashIndex && bashIndex >= 0, `bash at ${bashIndex}, msg at ${msgIndex}`),
			check("carol answered with reply_to", answers.some((args) => Boolean(args.reply_to)), JSON.stringify(answers)),
			check(
				"carol was told alice is blocked on her reply",
				toolResults(carolEntries, "msg_send").some((text) => text.includes("blocked waiting for this reply")),
				toolResults(carolEntries, "msg_send").join("\n"),
			),
			check("both exit 0", aliceDone.code === 0 && carolDone.code === 0, `alice ${aliceDone.code}, carol ${carolDone.code}\n${clip(aliceDone.stderr + carolDone.stderr)}`),
			check("alice's final answer is the secret word", /pineapple/i.test(aliceDone.stdout), clip(aliceDone.stdout)),
			noExtensionErrors(aliceDone.stderr + carolDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("steer busy: a pi -p asker reaches a busy pi -p run mid-task and gets its answer", checks);
};

const openHostedSession = async (w: World, modelRuntime: ModelRuntime, name: string): Promise<AgentSession> => {
	const [provider, ...rest] = MODEL.split("/");
	const model = modelRuntime.getModel(provider ?? "", rest.join("/"));
	if (!model) throw new Error(`model ${MODEL} not found`);
	const resourceLoader = new DefaultResourceLoader({ cwd: REPO, agentDir: getAgentDir(), noExtensions: true, noSkills: true, additionalExtensionPaths: [EXTENSION] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: REPO,
		sessionManager: SessionManager.create(REPO, w.sessions),
		modelRuntime,
		model,
		thinkingLevel: THINKING === "low" ? "low" : "medium",
		resourceLoader,
	});
	session.setSessionName(name);
	await session.bindExtensions({ mode: "rpc" });
	return session;
};

const ASK_WEB_A = [
	"You are alice. The agent session named web-a can do arithmetic for you.",
	'Ask it with one msg_send: to "web-a", message "What is 3+4? Answer with just the number.", wait_seconds 120.',
	"Then reply with just its answer and nothing else.",
].join(" ");

/**
 * pi-web's shape: several SDK sessions in one Bun process, each with its own copy of the extension,
 * disposed with session.dispose() and no session_shutdown.
 */
export const webHost = async (): Promise<boolean> => {
	const w = world("web");
	const checks: Check[] = [];
	const previousRoot = process.env.PI_MSG_DIR;
	const previousSession = process.env.PI_SESSION_ID;
	process.env.PI_MSG_DIR = w.store;
	delete process.env.PI_SESSION_ID;
	const sessions: AgentSession[] = [];
	try {
		const modelRuntime = await ModelRuntime.create();
		const a = await openHostedSession(w, modelRuntime, "web-a");
		sessions.push(a);
		const b = await openHostedSession(w, modelRuntime, "web-b");
		sessions.push(b);
		const recordA = await waitUntil("web-a online", () => presenceNamed(w, "web-a"), 10_000);
		const recordB = await waitUntil("web-b online", () => presenceNamed(w, "web-b"), 10_000);
		await sleep(STARTUP_GRACE_MS);
		const alice = spawnPi(w, piArgs(w, "alice", ["-p", ASK_WEB_A]));
		const aliceDone = await alice.done;
		const stillB = readPresence(w.store, recordB.id);
		b.dispose();
		const endedB = await waitUntil("web-b marked ended after dispose", () => readPresence(w.store, recordB.id)?.endedAt, 8_000).catch(() => undefined);
		const aAfterB = readPresence(w.store, recordA.id);
		a.dispose();
		const endedA = await waitUntil("web-a marked ended after dispose", () => readPresence(w.store, recordA.id)?.endedAt, 8_000).catch(() => undefined);
		checks.push(
			check("two sessions, one process, separate identities", recordA.id !== recordB.id && recordA.pid === recordB.pid && recordA.pid === process.pid),
			check("alice's msg_send got the hosted session's answer", aliceDone.code === 0 && /\b7\b/.test(aliceDone.stdout), clip(aliceDone.stdout + aliceDone.stderr)),
			check("only web-a was woken", customMessages(sessionEntries(w, recordB.id)).length === 0 && customMessages(sessionEntries(w, recordA.id)).length === 1),
			check("web-b stayed live until disposed", stillB?.endedAt === undefined),
			check("dispose() without session_shutdown still ends web-b's presence", endedB !== undefined),
			check("web-a unaffected by web-b's dispose", aAfterB?.endedAt === undefined),
			check("web-a ends too once disposed", endedA !== undefined),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		for (const session of sessions) session.dispose();
		if (previousRoot === undefined) delete process.env.PI_MSG_DIR;
		else process.env.PI_MSG_DIR = previousRoot;
		if (previousSession !== undefined) process.env.PI_SESSION_ID = previousSession;
		w.dispose();
	}
	return report("web host: two SDK sessions in one Bun process, disposed pi-web style", checks);
};

const BOSS_TASK = [
	"You are boss. Sessions started from your bash are your subs, and their messages wake you.",
	"When a sub asks for the build number, answer with msg_send to its session id with reply_to its message id: the build number is 7781.",
	'When a sub\'s report arrives (kind="ended"), reply with just the last line of that report, copied exactly, and nothing else.',
	"For now, reply with just READY.",
].join(" ");

const KID_TASK = [
	"You were started by another agent session, your parent.",
	'Ask it for the current build number with one msg_send: to "parent", wait_seconds 180.',
	"Then read the file report.txt in your working directory.",
	"Your final reply must be exactly the line `BUILD <the number> SHIPPED`, then the full contents of report.txt, unchanged, and nothing else.",
].join(" ");

const REPORT_TOKEN = "end of report: zebra-crossing-42";

const REPORT = [
	...Array.from({ length: 24 }, (_, index) => `check ${String(index + 1).padStart(2, "0")}: the parser keeps every field of record ${index + 1} intact`),
	REPORT_TOKEN,
].join("\n");

const SLEEPER_TASK = "Run the bash command `sleep 90` and wait for it to finish. Then reply DONE.";

const isEnded = (message: Message, from: string): boolean => message.kind === "ended" && message.from.id === from;

/**
 * Lineage, the way pi wires it: a sub started with its parent's id in PI_SESSION_ID (what pi's bash
 * does) asks the parent with wait_seconds; the parent, idle with its turn ended, wakes up and answers.
 * The sub's report, well over 600 chars, reaches the parent whole and wakes it again. Then a sub killed
 * with SIGKILL comes back as one `died`.
 */
export const lineage = async (): Promise<boolean> => {
	const w = world("lineage");
	const checks: Check[] = [];
	try {
		const boss = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc"]));
		const bossRecord = await waitUntil("boss online", () => presenceNamed(w, "boss"), ONLINE_TIMEOUT_MS);
		await sleep(STARTUP_GRACE_MS);
		rpc(boss, { id: "task", type: "prompt", message: BOSS_TASK });
		await waitUntil("boss ready and idle", () => (assistantTexts(sessionEntries(w, bossRecord.id)).length > 0 && readPresence(w.store, bossRecord.id)?.activity === "idle" ? true : undefined), 120_000);

		const kidFolder = join(w.base, "fork-1");
		mkdirSync(kidFolder, { recursive: true });
		writeFileSync(join(kidFolder, "report.txt"), `${REPORT}\n`);
		const kid = spawnPi(w, piArgs(w, "kid", ["-p", KID_TASK]), kidFolder, { PI_SESSION_ID: bossRecord.id });
		const kidRecord = await waitUntil("kid online", () => presenceNamed(w, "kid"), ONLINE_TIMEOUT_MS);
		const kidDone = await kid.done;
		const relayed = await waitUntil(
			"boss is woken by the kid's report and answers with its last line",
			() => {
				const entries = sessionEntries(w, bossRecord.id);
				const at = delivered(entries).find(({ message }) => isEnded(message, kidRecord.id))?.index;
				return at === undefined ? undefined : assistantTexts(entries).find(({ index }) => index > at)?.text;
			},
			180_000,
		).catch(() => undefined);
		await waitUntil("boss idle again", () => (readPresence(w.store, bossRecord.id)?.activity === "idle" ? true : undefined), 120_000).catch(() => undefined);

		const sleeper = spawnPi(w, piArgs(w, "sleeper", ["-p", SLEEPER_TASK]), REPO, { PI_SESSION_ID: bossRecord.id });
		const sleeperRecord = await waitUntil("sleeper busy", busyNamed(w, "sleeper"), ONLINE_TIMEOUT_MS);
		await sleep(6_000);
		sleeper.proc.kill("SIGKILL");
		const diedSeen = await waitUntil(
			"boss is told the sleeper died",
			() => (delivered(sessionEntries(w, bossRecord.id)).some(({ message }) => message.kind === "died") ? true : undefined),
			90_000,
		).catch(() => false);
		await sleep(6_000);
		boss.proc.stdin.end();
		const bossDone = await boss.done;

		const bossEntries = sessionEntries(w, bossRecord.id);
		const kidEntries = sessionEntries(w, kidRecord.id);
		const kidAsks = toolCalls(kidEntries, "msg_send") as { to?: string; wait_seconds?: number }[];
		const bossSends = toolCalls(bossEntries, "msg_send") as { reply_to?: string }[];
		const toBoss = inboxOf(w, bossRecord.id);
		const ended = toBoss.filter((message) => isEnded(message, kidRecord.id));
		const report = ended[0];
		const seen = delivered(bossEntries).find(({ message }) => isEnded(message, kidRecord.id));
		const kidWords = kidDone.stdout.trim();
		const died = toBoss.filter((message) => message.kind === "died");
		checks.push(
			check("boss has no parent; both subs name boss as their parent", bossRecord.parent === undefined && kidRecord.parent === bossRecord.id && sleeperRecord.parent === bossRecord.id, JSON.stringify([bossRecord.parent, kidRecord.parent, sleeperRecord.parent])),
			check("the kid asked its parent with wait_seconds", kidAsks.some((args) => args.to === "parent" && (args.wait_seconds ?? 0) > 0), JSON.stringify(kidAsks)),
			check("idle boss woke up for the question and answered with reply_to", delivered(bossEntries).some(({ message }) => message.from.id === kidRecord.id && message.kind === undefined) && bossSends.some((args) => Boolean(args.reply_to)), JSON.stringify(bossSends)),
			check("the kid exits 0 with the build number", kidDone.code === 0 && kidWords.includes("7781"), `${kidDone.code}: ${clip(kidWords)}\n${clip(kidDone.stderr)}`),
			check("exactly one ended from the kid, not stopped", ended.length === 1 && report?.stopped === undefined, JSON.stringify(ended.map((message) => [message.id, message.stopped]))),
			check("the report is well over 600 chars and arrived whole: the kid's whole final message", kidWords.length > 600 && report?.text === kidWords, `${report?.text.length ?? "?"} vs ${kidWords.length} chars: ${clip(report?.text ?? "", 200)}`),
			check("its end, past the old 600-char cut, is there with no lookup pointer", report?.text.includes(REPORT_TOKEN) === true && !report.text.includes("[+"), clip(report?.text.slice(-300) ?? "")),
			check("boss's conversation got the whole report", seen?.content.includes(kidWords) === true && seen.content.includes("its report"), clip(seen?.content.slice(-400) ?? "")),
			check("boss read it to the end: it answered with the report's last line", relayed?.includes("zebra-crossing-42") === true, String(relayed)),
			check("the killed sub came back as one died", diedSeen === true && died.length === 1 && died[0]?.from.id === sleeperRecord.id, JSON.stringify(died.map((message) => message.from.id))),
			check("no died for the kid that ended", !died.some((message) => message.from.id === kidRecord.id)),
			noExtensionErrors(bossDone.stderr + kidDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("lineage: rpc parent woken by its pi -p subs: a question, a whole 600+ char report, a death", checks);
};

const tryToReach = (to: string, first = ""): string =>
	[
		"This is a test of msg's addressing rules, run by the user who started you.",
		first,
		`Call msg_send exactly once, with to "${to}" and message "hello". It is expected to fail.`,
		"Then reply with the exact error text msg_send returned, and nothing else.",
	]
		.filter(Boolean)
		.join(" ");

/**
 * The tree is a wall: a sub messaging anyone but its parent is refused with one line, and a top-level
 * session messaging someone else's sub (here by its folder, a symlinked tmp path) is told to go through its parent.
 */
export const wall = async (): Promise<boolean> => {
	const w = world("wall");
	const checks: Check[] = [];
	try {
		const boss = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc"]));
		const stranger = spawnPi(w, piArgs(w, "stranger", ["--mode", "rpc"]));
		const bossRecord = await waitUntil("boss online", () => presenceNamed(w, "boss"), ONLINE_TIMEOUT_MS);
		const strangerRecord = await waitUntil("stranger online", () => presenceNamed(w, "stranger"), ONLINE_TIMEOUT_MS);
		const kidFolder = join(w.base, "fork-1");
		mkdirSync(kidFolder, { recursive: true });
		const kid = spawnPi(w, piArgs(w, "kid", ["-p", tryToReach(strangerRecord.id, "First run the bash command `sleep 15` and wait for it to finish.")]), kidFolder, {
			PI_SESSION_ID: bossRecord.id,
		});
		const kidRecord = await waitUntil("kid busy", busyNamed(w, "kid"), ONLINE_TIMEOUT_MS);
		const outsider = spawnPi(w, piArgs(w, "outsider", ["-p", tryToReach(kidFolder)]));
		const outsiderRecord = await waitUntil("outsider online", () => presenceNamed(w, "outsider"), ONLINE_TIMEOUT_MS);
		const [kidDone, outsiderDone] = await Promise.all([kid.done, outsider.done]);
		await waitUntil("the kid's ended reaches boss", () => inboxOf(w, bossRecord.id).find((message) => isEnded(message, kidRecord.id)), 10_000).catch(() => undefined);
		boss.proc.stdin.end();
		stranger.proc.stdin.end();
		const [bossDone, strangerDone] = await Promise.all([boss.done, stranger.done]);

		const kidResults = toolResults(sessionEntries(w, kidRecord.id), "msg_send");
		const outsiderResults = toolResults(sessionEntries(w, outsiderRecord.id), "msg_send");
		const subRefusal = `you're boss's sub: you can message only your parent (to: "parent")`;
		const wallRefusal = `kid (${kidRecord.id}) is boss's sub: message boss (${bossRecord.id})`;
		checks.push(
			check("kid is boss's sub; stranger and outsider are top-level", kidRecord.parent === bossRecord.id && strangerRecord.parent === undefined && outsiderRecord.parent === undefined),
			check("the sub's msg_send to the stranger was refused with one line", kidResults.some((text) => text.includes(subRefusal)), kidResults.join("\n")),
			check("the outsider's msg_send to the sub's folder was refused: message its parent", outsiderResults.some((text) => text.includes(wallRefusal)), outsiderResults.join("\n")),
			check("nothing reached the stranger", inboxOf(w, strangerRecord.id).length === 0, JSON.stringify(inboxOf(w, strangerRecord.id))),
			check("nothing reached the sub", inboxOf(w, kidRecord.id).length === 0, JSON.stringify(inboxOf(w, kidRecord.id))),
			check("each reported the refusal", kidDone.stdout.includes("only your parent") && outsiderDone.stdout.includes("is boss's sub"), clip(`${kidDone.stdout}\n${outsiderDone.stdout}`)),
			check("the sub's report still reached its parent", inboxOf(w, bossRecord.id).some((message) => isEnded(message, kidRecord.id))),
			noExtensionErrors(kidDone.stderr + outsiderDone.stderr + bossDone.stderr + strangerDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("wall: a sub reaches only its parent; only its parent reaches a sub", checks);
};

/** A pi started from a sub's bash (its PI_SESSION_ID) refuses to run: it says why and exits without running its prompt. */
export const nested = async (): Promise<boolean> => {
	const w = world("nested");
	const checks: Check[] = [];
	try {
		const boss = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc"]));
		const bossRecord = await waitUntil("boss online", () => presenceNamed(w, "boss"), ONLINE_TIMEOUT_MS);
		const kid = spawnPi(w, piArgs(w, "kid", ["-p", SLEEPER_TASK]), REPO, { PI_SESSION_ID: bossRecord.id });
		const kidRecord = await waitUntil("kid busy", busyNamed(w, "kid"), ONLINE_TIMEOUT_MS);
		const startedAt = Date.now();
		const grandkid = spawnPi(w, piArgs(w, "grandkid", ["-p", "Reply with just the word PINEAPPLE."]), REPO, { PI_SESSION_ID: kidRecord.id });
		const grandkidDone = await grandkid.done;
		const took = Date.now() - startedAt;
		const records = listPresence(w.store);
		kid.proc.kill("SIGTERM");
		const kidDone = await kid.done;
		boss.proc.stdin.end();
		const bossDone = await boss.done;
		const refusal = `nested subs aren't allowed: kid (${kidRecord.id}) is itself a sub. ask your parent instead.`;
		checks.push(
			check("kid is boss's sub", kidRecord.parent === bossRecord.id),
			check("the nested pi -p exits 1, quickly", grandkidDone.code === 1 && took < 20_000, `exit ${grandkidDone.code} after ${took}ms`),
			check("it says why on stderr", grandkidDone.stderr.includes(refusal), clip(grandkidDone.stderr)),
			check("its prompt never ran: no answer, nothing in any session file", !grandkidDone.stdout.includes("PINEAPPLE") && !allSessionText(w).includes("PINEAPPLE"), clip(grandkidDone.stdout)),
			check("it never joined the store: no record for it, none names the kid as parent", !records.some((record) => record.name === "grandkid" || record.parent === kidRecord.id), JSON.stringify(records.map((record) => [record.name, record.parent]))),
			check("the kid got no mail from it", inboxOf(w, kidRecord.id).length === 0),
			noExtensionErrors(kidDone.stderr + bossDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("nested: a pi started from a sub's bash refuses to run", checks);
};

/**
 * A sub that goes away mid-run (SIGTERM, what pi-web's Esc sends a sub) and an rpc sub whose last run was
 * aborted both report `stopped`; a sub that finished doesn't. The parent's agent reads the difference.
 */
export const stopped = async (): Promise<boolean> => {
	const w = world("stopped");
	const checks: Check[] = [];
	try {
		const boss = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc"]));
		const bossRecord = await waitUntil("boss online", () => presenceNamed(w, "boss"), ONLINE_TIMEOUT_MS);
		const asSub = { PI_SESSION_ID: bossRecord.id };
		const killed = spawnPi(w, piArgs(w, "killed", ["-p", SLEEPER_TASK]), REPO, asSub);
		const aborted = spawnPi(w, piArgs(w, "aborted", ["--mode", "rpc"]), REPO, asSub);
		const finisher = spawnPi(w, piArgs(w, "finisher", ["-p", "Reply with just the word OK."]), REPO, asSub);
		const killedRecord = await waitUntil("killed busy", busyNamed(w, "killed"), ONLINE_TIMEOUT_MS);
		const abortedRecord = await waitUntil("aborted online", () => presenceNamed(w, "aborted"), ONLINE_TIMEOUT_MS);
		const finisherRecord = await waitUntil("finisher online", () => listPresence(w.store).find((record) => record.name === "finisher"), ONLINE_TIMEOUT_MS);
		await sleep(STARTUP_GRACE_MS);
		rpc(aborted, { id: "work", type: "prompt", message: SLEEPER_TASK });
		await waitUntil("aborted busy", busyNamed(w, "aborted"), ONLINE_TIMEOUT_MS);
		await waitUntil("both in their bash call", () => (toolCalls(sessionEntries(w, killedRecord.id), "bash").length > 0 && toolCalls(sessionEntries(w, abortedRecord.id), "bash").length > 0 ? true : undefined), 60_000);
		await sleep(2_000);
		killed.proc.kill("SIGTERM");
		rpc(aborted, { id: "stop", type: "abort" });
		await waitUntil("aborted idle after the abort", () => (readPresence(w.store, abortedRecord.id)?.activity === "idle" ? true : undefined), 30_000);
		aborted.proc.stdin.end();
		const [killedDone, abortedDone, finisherDone] = await Promise.all([killed.done, aborted.done, finisher.done]);
		const framed = await waitUntil(
			"boss's conversation shows all three",
			() => {
				const seen = delivered(sessionEntries(w, bossRecord.id)).filter(({ message }) => message.kind === "ended");
				return seen.length >= 3 ? seen : undefined;
			},
			60_000,
		).catch(() => delivered(sessionEntries(w, bossRecord.id)).filter(({ message }) => message.kind === "ended"));
		await sleep(3_000);
		boss.proc.stdin.end();
		const bossDone = await boss.done;

		const toBoss = inboxOf(w, bossRecord.id);
		const endedFrom = (record: Presence) => toBoss.filter((message) => isEnded(message, record.id));
		const framing = (record: Presence) => framed.find(({ message }) => message.from.id === record.id)?.content ?? "";
		const stoppedNote = "was stopped before it finished";
		checks.push(
			check("all three are boss's subs", [killedRecord, abortedRecord, finisherRecord].every((record) => record.parent === bossRecord.id)),
			check("SIGTERM mid-run: one ended, stopped", endedFrom(killedRecord).length === 1 && endedFrom(killedRecord)[0]?.stopped === true, JSON.stringify(endedFrom(killedRecord))),
			check("an aborted last run: one ended, stopped", endedFrom(abortedRecord).length === 1 && endedFrom(abortedRecord)[0]?.stopped === true, JSON.stringify(endedFrom(abortedRecord))),
			check("a finished pi -p: one ended, not stopped", endedFrom(finisherRecord).length === 1 && endedFrom(finisherRecord)[0]?.stopped === undefined && finisherDone.code === 0, JSON.stringify(endedFrom(finisherRecord))),
			check("no died for any of them", !toBoss.some((message) => message.kind === "died")),
			check("boss's agent read the stopped ones as stopped: inspect before relying on them", [killedRecord, abortedRecord].every((record) => framing(record).includes(stoppedNote) && framing(record).includes("Inspect its work")), clip(framing(killedRecord) + framing(abortedRecord))),
			check("and the finished one as a report", framing(finisherRecord).includes("its report") && !framing(finisherRecord).includes(stoppedNote), clip(framing(finisherRecord))),
			noExtensionErrors(killedDone.stderr + abortedDone.stderr + finisherDone.stderr + bossDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("stopped: subs stopped mid-run or aborted report stopped; a finished one doesn't", checks);
};

const diedTo = (w: World, box: string): Message[] => inboxOf(w, box).filter((message) => message.kind === "died");

const sameLife = (message: Message | undefined, record: Presence): boolean =>
	message?.life?.pid === record.pid && message.life.startedAt === record.startedAt;

const deliveredDied = (w: World, id: string): boolean => customMessages(sessionEntries(w, id)).some((entry) => (entry.details as Message | undefined)?.kind === "died");

/**
 * Subs that don't last: one SIGKILLed about a second after its msg starts gets exactly one `died`,
 * within a tick or two (the parent finds new subs every tick and judges ones it never saw live);
 * one SIGTERMed as soon ends cleanly: `ended`, never `died`.
 */
export const quickDeath = async (): Promise<boolean> => {
	const w = world("quick");
	const checks: Check[] = [];
	try {
		const boss = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc"]));
		const bossRecord = await waitUntil("boss online", () => presenceNamed(w, "boss"), ONLINE_TIMEOUT_MS);
		const asChild = { PI_SESSION_ID: bossRecord.id };
		const crasher = spawnPi(w, piArgs(w, "crasher", ["-p", SLEEPER_TASK]), REPO, asChild);
		const crasherRecord = await waitUntil("crasher online", () => presenceNamed(w, "crasher"), ONLINE_TIMEOUT_MS, 50);
		await sleep(1_000);
		crasher.proc.kill("SIGKILL");
		const killedAt = Date.now();
		const quitter = spawnPi(w, piArgs(w, "quitter", ["-p", SLEEPER_TASK]), REPO, asChild);
		const quitterRecord = await waitUntil("quitter online", () => presenceNamed(w, "quitter"), ONLINE_TIMEOUT_MS, 50);
		await sleep(1_000);
		quitter.proc.kill("SIGTERM");
		const [crasherDone, quitterDone] = await Promise.all([crasher.done, quitter.done]);
		const died = await waitUntil("boss records the crasher's died", () => diedTo(w, bossRecord.id)[0], 20_000).catch(() => undefined);
		const deliveredToBoss = await waitUntil("the died reaches boss's conversation", () => (deliveredDied(w, bossRecord.id) ? true : undefined), 30_000).catch(() => false);
		await sleep(12_000);
		boss.proc.stdin.end();
		const bossDone = await boss.done;

		const toBoss = inboxOf(w, bossRecord.id);
		const deaths = diedTo(w, bossRecord.id);
		const quitterEnded = toBoss.filter((message) => message.kind === "ended" && message.from.id === quitterRecord.id);
		checks.push(
			check("both subs name boss as their parent", crasherRecord.parent === bossRecord.id && quitterRecord.parent === bossRecord.id),
			check("SIGKILL left the crasher's record without endedAt", readPresence(w.store, crasherRecord.id)?.endedAt === undefined && crasherDone.code !== 0),
			check("exactly one died, from the crasher", deaths.length === 1 && deaths[0]?.from.id === crasherRecord.id, JSON.stringify(deaths.map((message) => [message.from.name, message.text]))),
			check("it names the crasher's life", sameLife(died, crasherRecord), JSON.stringify([died?.life, crasherRecord.pid, crasherRecord.startedAt])),
			check("it came within a few seconds of the kill", died !== undefined && died.ts - killedAt < 5_000, `${died ? died.ts - killedAt : "?"}ms after the kill`),
			check("boss got it delivered", deliveredToBoss === true),
			check(
				"the SIGTERMed quitter ended: one ended, no died",
				quitterEnded.length === 1 && readPresence(w.store, quitterRecord.id)?.endedAt !== undefined && !deaths.some((message) => message.from.id === quitterRecord.id),
				`exit ${quitterDone.code}, ${JSON.stringify(quitterEnded)}`,
			),
			noExtensionErrors(bossDone.stderr + crasherDone.stderr + quitterDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("quick death: a sub SIGKILLed a second in gets one died; one SIGTERMed ends", checks);
};

/** A sub SIGKILLed while its parent is stopped: the parent reports it when it resumes, and a second resume adds nothing. */
export const offlineDeath = async (): Promise<boolean> => {
	const w = world("offline");
	const checks: Check[] = [];
	try {
		const first = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc"]));
		const bossRecord = await waitUntil("boss online", () => presenceNamed(w, "boss"), ONLINE_TIMEOUT_MS);
		await sleep(STARTUP_GRACE_MS);
		rpc(first, { id: "hello", type: "prompt", message: "Reply with just OK." });
		await waitUntil("boss has a session file to resume", () => (assistantTexts(sessionEntries(w, bossRecord.id)).length > 0 ? true : undefined), 120_000);
		const kid = spawnPi(w, piArgs(w, "kid", ["-p", SLEEPER_TASK]), REPO, { PI_SESSION_ID: bossRecord.id });
		const kidRecord = await waitUntil("kid busy", busyNamed(w, "kid"), ONLINE_TIMEOUT_MS);
		first.proc.stdin.end();
		const firstDone = await first.done;
		const bossStopped = readPresence(w.store, bossRecord.id)?.endedAt !== undefined;
		kid.proc.kill("SIGKILL");
		await kid.done;
		await sleep(2_000);
		const whileStopped = diedTo(w, bossRecord.id).length;

		const resume = async (label: string): Promise<{ run: Run; record: Presence }> => {
			const previous = readPresence(w.store, bossRecord.id)?.startedAt ?? 0;
			const run = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc", "--session", bossRecord.id]));
			const record = await waitUntil(
				label,
				() => {
					const found = readPresence(w.store, bossRecord.id);
					return found && found.endedAt === undefined && found.startedAt > previous ? found : undefined;
				},
				ONLINE_TIMEOUT_MS,
			);
			return { run, record };
		};
		const second = await resume("boss resumed");
		const died = await waitUntil("the resumed boss records the kid's died", () => diedTo(w, bossRecord.id)[0], 15_000).catch(() => undefined);
		const deliveredToBoss = await waitUntil("the died reaches boss's conversation", () => (deliveredDied(w, bossRecord.id) ? true : undefined), 30_000).catch(() => false);
		await waitUntil("boss idle again", () => (readPresence(w.store, bossRecord.id)?.activity === "idle" ? true : undefined), 120_000).catch(() => undefined);
		second.run.proc.stdin.end();
		const secondDone = await second.run.done;
		const third = await resume("boss resumed again");
		await sleep(12_000);
		third.run.proc.stdin.end();
		const thirdDone = await third.run.done;

		const deaths = diedTo(w, bossRecord.id);
		checks.push(
			check("the kid names boss as its parent", kidRecord.parent === bossRecord.id),
			check("boss's record ended when it stopped", bossStopped),
			check("nothing was reported while boss was stopped", whileStopped === 0),
			check("the resumed boss reported the kid's death", died?.from.id === kidRecord.id && died.ts >= second.record.startedAt, JSON.stringify(died)),
			check("it names the kid's life", sameLife(died, kidRecord), JSON.stringify([died?.life, kidRecord.pid, kidRecord.startedAt])),
			check("it was delivered into boss's conversation", deliveredToBoss === true),
			check("a second resume adds nothing: exactly one died", deaths.length === 1, JSON.stringify(deaths.map((message) => [message.id, message.ts]))),
			noExtensionErrors(firstDone.stderr + secondDone.stderr + thirdDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("offline death: a sub SIGKILLed while its parent is stopped is reported on resume, once", checks);
};

export const SCENARIOS = { rpcWake, steerBusy, webHost, lineage, wall, nested, stopped, quickDeath, offlineDeath } as const;
