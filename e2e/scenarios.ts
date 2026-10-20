import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "../src/core/message.ts";
import { pending } from "../src/core/maildir.ts";
import { listPresence, pidAlive, type Presence, readPresence } from "../src/core/registry.ts";
import { findRecipients, post, senderOf } from "../src/core/send.ts";
import { timeoutNote } from "../src/core/timeout.ts";
import {
	allSessionText,
	assistantTexts,
	busyNamed,
	type Check,
	check,
	customMessages,
	delivered,
	descendantsOf,
	EXTENSION,
	inboxOf,
	MODEL,
	piArgs,
	presenceNamed,
	type Proc,
	processes,
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
const SAY_THEN_SLEEP = `First say, in one short sentence, what you're about to do. Then: ${SLEEPER_TASK}`;

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
 * A sub that goes away mid-run (SIGTERM, how pi-web stops a pi running elsewhere) and an rpc sub whose last run was
 * aborted both report `stopped`, with their last words (pi records an abort mid-tool as an error; that echo isn't
 * the report); a sub that finished doesn't. The parent's agent reads the difference.
 */
export const stopped = async (): Promise<boolean> => {
	const w = world("stopped");
	const checks: Check[] = [];
	try {
		const boss = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc"]));
		const bossRecord = await waitUntil("boss online", () => presenceNamed(w, "boss"), ONLINE_TIMEOUT_MS);
		const asSub = { PI_SESSION_ID: bossRecord.id };
		const killed = spawnPi(w, piArgs(w, "killed", ["-p", SAY_THEN_SLEEP]), REPO, asSub);
		const aborted = spawnPi(w, piArgs(w, "aborted", ["--mode", "rpc"]), REPO, asSub);
		const finisher = spawnPi(w, piArgs(w, "finisher", ["-p", "Reply with just the word OK."]), REPO, asSub);
		const killedRecord = await waitUntil("killed busy", busyNamed(w, "killed"), ONLINE_TIMEOUT_MS);
		const abortedRecord = await waitUntil("aborted online", () => presenceNamed(w, "aborted"), ONLINE_TIMEOUT_MS);
		const finisherRecord = await waitUntil("finisher online", () => listPresence(w.store).find((record) => record.name === "finisher"), ONLINE_TIMEOUT_MS);
		await sleep(STARTUP_GRACE_MS);
		rpc(aborted, { id: "work", type: "prompt", message: SAY_THEN_SLEEP });
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
		const lastSaid = (record: Presence) => assistantTexts(sessionEntries(w, record.id)).at(-1)?.text.trim() ?? "(it ended without a final message)";
		const saidLast = (record: Presence) => endedFrom(record)[0]?.text === lastSaid(record) && !endedFrom(record)[0]?.text.includes("failed with an error");
		checks.push(
			check("all three are boss's subs", [killedRecord, abortedRecord, finisherRecord].every((record) => record.parent === bossRecord.id)),
			check("SIGTERM mid-run: one ended, stopped", endedFrom(killedRecord).length === 1 && endedFrom(killedRecord)[0]?.stopped === true, JSON.stringify(endedFrom(killedRecord))),
			check("an aborted last run: one ended, stopped", endedFrom(abortedRecord).length === 1 && endedFrom(abortedRecord)[0]?.stopped === true, JSON.stringify(endedFrom(abortedRecord))),
			check("a finished pi -p: one ended, not stopped", endedFrom(finisherRecord).length === 1 && endedFrom(finisherRecord)[0]?.stopped === undefined && finisherDone.code === 0, JSON.stringify(endedFrom(finisherRecord))),
			check("no died for any of them", !toBoss.some((message) => message.kind === "died")),
			check(
				"each stopped report is the sub's last words, not the stop's error echo",
				[killedRecord, abortedRecord].every(saidLast),
				JSON.stringify([killedRecord, abortedRecord].map((record) => [endedFrom(record)[0]?.text, lastSaid(record)])),
			),
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

/** The stall threshold the boss runs with: past a few full scans of a sub's record, well short of a test's patience and of a sub's default bash timeout. */
const STALL_AFTER_MS = 8_000;
const WAIT_SECONDS = 40;

const OBSERVER_TASK = [
	"You are boss, observing a test. Messages from your subs will arrive while you wait.",
	"Whatever a message says or asks, reply to it with just the word NOTED: never use a tool, never send a message, never answer a question.",
	"For now, reply with just READY.",
].join(" ");

const STUCK_TASK = "First say, in one short sentence, what you're about to do. Then run the bash command `sleep 613` in the foreground, with no timeout, and wait for it to finish. Then reply DONE.";

const WAITER_TASK = [
	"You were started by another agent session, your parent.",
	`Call msg_send exactly once: to "parent", message "Holding here until you say go; no need to reply.", wait_seconds ${WAIT_SECONDS}.`,
	"When it returns, reply with just WAITED.",
].join(" ");

const stalledTo = (w: World, box: string): Message[] => inboxOf(w, box).filter((message) => message.kind === "stalled");

/** The bash results in a session, with their place in it and whether they failed. */
const bashResults = (entries: readonly Record<string, unknown>[]): { readonly text: string; readonly isError: boolean; readonly index: number }[] =>
	entries.flatMap((entry, index) => {
		const message = entry.message as { role?: string; toolName?: string; isError?: boolean; content?: { type?: string; text?: string }[] } | undefined;
		if (entry.type !== "message" || message?.role !== "toolResult" || message.toolName !== "bash") return [];
		const text = (message.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
		return [{ text, isError: message.isError === true, index }];
	});

/** The stuck command's own `kill -- -<pgid>` a notice names, and the group. */
const groupStopIn = (text: string | undefined): { readonly command: string; readonly pgid: number } | undefined => {
	const match = /`(kill -- -(\d+))`/.exec(text ?? "");
	return match?.[1] && match[2] ? { command: match[1], pgid: Number(match[2]) } : undefined;
};

/**
 * A sub stuck in a command that never returns keeps heartbeating, so it never dies: its parent gets one `stalled`
 * naming the call, the command's own process group and the commands that stop either. Stopping just the command,
 * after a message telling the sub what to do instead, kills the sleep alone: the call comes back failed, the sub reads
 * the message before its next step and finishes, not stopped, as told. Stopping the sub ends it stopped, with its last
 * words, and its sleep goes with it. A sub blocked in msg_send on its parent past the threshold isn't stuck: no `stalled`.
 */
export const stalled = async (): Promise<boolean> => {
	const w = world("stalled");
	const checks: Check[] = [];
	let sleeps: Proc[] = [];
	try {
		const boss = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc"]), REPO, { PI_MSG_STALLED_AFTER_MS: String(STALL_AFTER_MS) });
		const bossRecord = await waitUntil("boss online", () => presenceNamed(w, "boss"), ONLINE_TIMEOUT_MS);
		await sleep(STARTUP_GRACE_MS);
		rpc(boss, { id: "task", type: "prompt", message: OBSERVER_TASK });
		await waitUntil("boss ready and idle", () => (assistantTexts(sessionEntries(w, bossRecord.id)).length > 0 && readPresence(w.store, bossRecord.id)?.activity === "idle" ? true : undefined), 120_000);

		const asSub = { PI_SESSION_ID: bossRecord.id };
		const freed = spawnPi(w, piArgs(w, "freed", ["-p", STUCK_TASK]), REPO, asSub);
		const stuck = spawnPi(w, piArgs(w, "stuck", ["-p", STUCK_TASK]), REPO, asSub);
		const waiter = spawnPi(w, piArgs(w, "waiter", ["-p", WAITER_TASK]), REPO, asSub);
		const freedRecord = await waitUntil("freed online", () => presenceNamed(w, "freed"), ONLINE_TIMEOUT_MS);
		const stuckRecord = await waitUntil("stuck online", () => presenceNamed(w, "stuck"), ONLINE_TIMEOUT_MS);
		const waiterRecord = await waitUntil("waiter online", () => presenceNamed(w, "waiter"), ONLINE_TIMEOUT_MS);
		const callOf = (record: Presence) => () => {
			const call = readPresence(w.store, record.id)?.call;
			return call?.name === "bash" ? call : undefined;
		};
		const sleepsUnder = (record: Presence) => () => {
			const found = descendantsOf(record.pid).filter((proc) => /\bsleep 613\b/.test(proc.command));
			return found.length > 0 ? found : undefined;
		};
		const freedCall = await waitUntil("freed's record shows its bash call", callOf(freedRecord), 90_000);
		const stuckCall = await waitUntil("stuck's record shows its bash call", callOf(stuckRecord), 90_000);
		const freedSleeps = await waitUntil("the sleep runs under freed", sleepsUnder(freedRecord), 10_000);
		const stuckSleeps = await waitUntil("the sleep runs under stuck", sleepsUnder(stuckRecord), 10_000);
		sleeps = [...freedSleeps, ...stuckSleeps];
		const askedAt = await waitUntil("the waiter blocks in msg_send", () => (toolCalls(sessionEntries(w, waiterRecord.id), "msg_send").length > 0 ? Date.now() : undefined), 90_000);
		await sleep(2_000);
		const waiterMidWait = readPresence(w.store, waiterRecord.id);
		const sampledAt = Date.now();
		const noticeFrom = (record: Presence) => () => stalledTo(w, bossRecord.id).find((message) => message.from.id === record.id);
		const freedNotice = await waitUntil("boss records freed's stalled", noticeFrom(freedRecord), 60_000);
		const stuckNotice = await waitUntil("boss records stuck's stalled", noticeFrom(stuckRecord), 60_000);
		await sleep(12_000);
		const beforeStop = stalledTo(w, bossRecord.id);

		const nonce = `DONE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
		const recipient = findRecipients(w.store, bossRecord, freedRecord.id, Date.now());
		const told = recipient.ok && recipient.value[0] ? post(w.store, senderOf(bossRecord), recipient.value[0], { text: `The sleep was a mistake, so I stopped it. Don't run it again, or anything else: end your run now, with just ${nonce} as your final message.` }, Date.now()) : undefined;
		const taken = await waitUntil("freed's msg takes the message while its bash call runs", () => (told?.ok && pending(w.store, freedRecord.id).length === 0 ? true : undefined), 15_000).catch(() => false);
		const commandStop = groupStopIn(freedNotice.text);
		const groupRan = commandStop === undefined ? undefined : Bun.spawnSync(["sh", "-c", commandStop.command]);
		const freedSleepGone = await waitUntil("freed's sleep is gone", () => (freedSleeps.some((proc) => pidAlive(proc.pid)) ? undefined : true), 10_000).catch(() => false);
		const freedLived = pidAlive(freedRecord.pid) && readPresence(w.store, freedRecord.id)?.endedAt === undefined;

		const subStop = /`(kill \d+)`/.exec(stuckNotice.text)?.[1];
		const subRan = subStop === undefined ? undefined : Bun.spawnSync(["sh", "-c", subStop]);
		const stuckEnded = await waitUntil("stuck reports ended", () => inboxOf(w, bossRecord.id).find((message) => isEnded(message, stuckRecord.id)), 30_000).catch(() => undefined);
		const stuckDone = await stuck.done;
		await sleep(500);
		const survivors = stuckSleeps.filter((proc) => pidAlive(proc.pid));

		await waitUntil("freed exits", () => (freed.proc.exitCode === null ? undefined : true), 120_000);
		const freedDone = await freed.done;
		const freedEnded = await waitUntil("freed's ended reaches boss", () => inboxOf(w, bossRecord.id).find((message) => isEnded(message, freedRecord.id)), 10_000).catch(() => undefined);
		const waiterDone = await waiter.done;
		const waiterEnded = await waitUntil("the waiter's ended reaches boss", () => inboxOf(w, bossRecord.id).find((message) => isEnded(message, waiterRecord.id)), 10_000).catch(() => undefined);
		const framed = await waitUntil(
			"boss's conversation shows both stalls",
			() => {
				const seen = delivered(sessionEntries(w, bossRecord.id)).filter(({ message }) => message.kind === "stalled");
				return seen.length >= 2 ? seen : undefined;
			},
			30_000,
		).catch(() => delivered(sessionEntries(w, bossRecord.id)).filter(({ message }) => message.kind === "stalled"));
		await waitUntil("boss idle again", () => (readPresence(w.store, bossRecord.id)?.activity === "idle" ? true : undefined), 60_000).catch(() => undefined);
		boss.proc.stdin.end();
		const bossDone = await boss.done;

		const stalls = stalledTo(w, bossRecord.id);
		const subs = [
			{ record: freedRecord, call: freedCall, notice: freedNotice, sleeps: freedSleeps },
			{ record: stuckRecord, call: stuckCall, notice: stuckNotice, sleeps: stuckSleeps },
		];
		const noticesFrom = (messages: readonly Message[], record: Presence) => messages.filter((message) => message.from.id === record.id);
		const freedEntries = sessionEntries(w, freedRecord.id);
		const failedAt = bashResults(freedEntries).find((result) => result.isError);
		const toldAt = delivered(freedEntries).find(({ message }) => told?.ok === true && message.id === told.value.id)?.index;
		const lastWordsAt = assistantTexts(freedEntries).at(-1)?.index;
		const lastSaid = assistantTexts(sessionEntries(w, stuckRecord.id)).at(-1)?.text.trim() ?? "(it ended without a final message)";
		const bothRemedies = "stop it with a command above: just the stuck command (msg_send it what to do instead first), or the whole sub.";
		const waits = toolResults(sessionEntries(w, waiterRecord.id), "msg_send");
		const waited = Number(/No reply from .* within (\d+)s/.exec(waits.join("\n"))?.[1] ?? 0);
		checks.push(
			check("all three are boss's subs", [freedRecord, stuckRecord, waiterRecord].every((record) => record.parent === bossRecord.id)),
			check("each stuck sub's record shows its oldest call: bash, sleep 613", subs.every(({ call }) => call.name === "bash" && call.preview?.includes("sleep 613") === true), JSON.stringify(subs.map(({ call }) => call))),
			check(
				"one stalled per stuck sub, before and after another full scan",
				subs.every(({ record }) => noticesFrom(beforeStop, record).length === 1 && noticesFrom(stalls, record).length === 1) && stalls.length === 2,
				JSON.stringify(stalls.map((message) => [message.from.name, message.call?.id])),
			),
			check(
				"each is from its sub, naming its life and its call",
				subs.every(({ record, call, notice }) => notice.life?.pid === record.pid && notice.life.startedAt === record.startedAt && notice.call?.id === call.id && notice.call.since === call.since),
				JSON.stringify(subs.map(({ notice, call }) => [notice.life, notice.call, call])),
			),
			check("each came after the call ran past the threshold", subs.every(({ notice, call }) => notice.ts - call.since > STALL_AFTER_MS), JSON.stringify(subs.map(({ notice, call }) => notice.ts - call.since))),
			check(
				"each names the call, `kill -- -<pgid>` with the group its sleep runs in, and `kill <pid>`",
				subs.every(({ record, notice, sleeps: own }) => notice.text.includes("bash: sleep 613") && groupStopIn(notice.text)?.pgid === own[0]?.pgid && notice.text.includes(`\`kill ${record.pid}\``)),
				JSON.stringify(subs.map(({ notice, sleeps: own }) => [groupStopIn(notice.text), own])),
			),
			check("stopping just the command comes first, then the sub", subs.every(({ notice }) => notice.text.indexOf("To stop just that command") >= 0 && notice.text.indexOf("To stop just that command") < notice.text.indexOf(" itself, run `kill ")), clip(freedNotice.text)),
			check(
				"boss's agent read each as a stalled sub, with both remedies",
				framed.length === 2 && framed.every(({ content }) => content.includes('kind="stalled"') && content.includes("is stalled") && content.includes(bothRemedies)),
				clip(framed[0]?.content ?? ""),
			),
			check("freed: msg_send first, as boss; freed's msg took it while its bash call ran", told?.ok === true && taken === true, JSON.stringify(told)),
			check("then the notice's `kill -- -<pgid>` ran", groupRan?.exitCode === 0, `${commandStop?.command}: exit ${groupRan?.exitCode}`),
			check("freed's sleep 613 is gone", freedSleepGone === true, JSON.stringify(freedSleeps)),
			check("freed's pi is still alive right after", freedLived),
			check("its bash call came back failed", failedAt !== undefined && /Command exited with code 143/.test(failedAt.text), clip(failedAt?.text ?? JSON.stringify(bashResults(freedEntries)))),
			check(
				"its session has the message after the failed tool result and before its last text",
				failedAt !== undefined && toldAt !== undefined && lastWordsAt !== undefined && failedAt.index < toldAt && toldAt < lastWordsAt,
				`failed result at ${failedAt?.index}, message at ${toldAt}, last text at ${lastWordsAt}`,
			),
			check(
				"freed ended, not stopped, exit 0, and its report has the nonce",
				freedEnded !== undefined && freedEnded.stopped === undefined && freedDone.code === 0 && freedEnded.text.includes(nonce),
				`exit ${freedDone.code}, ${nonce}: ${JSON.stringify(freedEnded)}`,
			),
			check("stuck: the notice's `kill <pid>` ran", subRan?.exitCode === 0, `${subStop}: exit ${subRan?.exitCode}`),
			check("stuck ended, stopped, with its last words", stuckEnded?.stopped === true && stuckEnded.text === lastSaid, JSON.stringify([stuckEnded?.stopped, stuckEnded?.text, lastSaid])),
			check("its pi exited on the SIGTERM", stuckDone.code === 143, `exit ${stuckDone.code}`),
			check("and its sleep went with it", survivors.length === 0, JSON.stringify({ stuckSleeps, survivors })),
			check(
				"the waiter's record shows no call while it's blocked in msg_send",
				waiterMidWait !== undefined && waiterMidWait.endedAt === undefined && waiterMidWait.activity === "busy" && waiterMidWait.call === undefined && sampledAt - askedAt < WAIT_SECONDS * 1_000,
				JSON.stringify(waiterMidWait),
			),
			check(`its msg_send waited past the threshold, ${WAIT_SECONDS}s, for no reply`, waited * 1_000 > 2 * STALL_AFTER_MS, waits.join("\n")),
			check("no stalled for the waiter", !stalls.some((message) => message.from.id === waiterRecord.id)),
			check("the waiter ended, not stopped", waiterEnded !== undefined && waiterEnded.stopped === undefined && waiterDone.code === 0, `exit ${waiterDone.code}: ${JSON.stringify(waiterEnded)}`),
			check("no died", !inboxOf(w, bossRecord.id).some((message) => message.kind === "died")),
			noExtensionErrors(freedDone.stderr + stuckDone.stderr + waiterDone.stderr + bossDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		const ours = new Set(sleeps.map((proc) => proc.pid));
		const leftover = ours.size === 0 ? [] : processes().filter((proc) => ours.has(proc.pid) && /\bsleep 613\b/.test(proc.command));
		for (const proc of leftover) process.kill(proc.pid, "SIGKILL");
		w.dispose();
	}
	return report("stalled: a stuck sub's parent gets one stalled naming the command's group and the sub's pid; stopping just the command lets the sub carry on, stopping the sub ends it stopped; a sub waiting on its parent gets none", checks);
};

/** The default timeout every session in the timeout scenario runs with: a sub's call without one dies this fast. */
const SHORT_TIMEOUT_MS = 3_000;

const TIMEOUT_BOSS_TASK = [
	"You are boss, observing a test.",
	"First run the bash command `sleep 5 && echo BOSS-SLEPT` in the foreground, with no timeout, and wait for it to finish; then reply with just its output.",
	"Later, messages from your subs will arrive: whatever a message says or asks, reply to it with just the word NOTED: never use a tool, never send a message.",
].join(" ");

const BOUNDED_TASK = "Run the bash command `sleep 617` in the foreground, with no timeout, exactly once, and wait for it to return. Whatever it returns, run nothing else: reply with just the word DONE.";

const PATIENT_TASK = "Run the bash command `sleep 4 && echo SLEPT` with a timeout of 20 seconds, exactly once, and wait for it to finish. Then reply with just its output.";

interface BashArgs {
	readonly command?: string;
	readonly timeout?: number | null;
}

/** A bash call the model gave no timeout: strict tool schemas have it send null for one it leaves out. */
const setsNoTimeout = (args: BashArgs | undefined): boolean => args !== undefined && (args.timeout === undefined || args.timeout === null);

/**
 * A sub's bash call without a timeout gets msg's default (PI_MSG_SUB_TIMEOUT_MS, 3s here): pi kills the command at it,
 * the result says so plus msg's note, and the sub carries on, finishes and reports, not stopped. A sub's call with its
 * own timeout keeps it, and the parent's own bash gets no default.
 */
export const timeout = async (): Promise<boolean> => {
	const w = world("timeout");
	const checks: Check[] = [];
	let sleeps: Proc[] = [];
	try {
		const knob = { PI_MSG_SUB_TIMEOUT_MS: String(SHORT_TIMEOUT_MS) };
		const boss = spawnPi(w, piArgs(w, "boss", ["--mode", "rpc"]), REPO, knob);
		const bossRecord = await waitUntil("boss online", () => presenceNamed(w, "boss"), ONLINE_TIMEOUT_MS);
		await sleep(STARTUP_GRACE_MS);
		rpc(boss, { id: "task", type: "prompt", message: TIMEOUT_BOSS_TASK });
		await waitUntil(
			"boss ran its bash and is idle",
			() => (toolResults(sessionEntries(w, bossRecord.id), "bash").length > 0 && readPresence(w.store, bossRecord.id)?.activity === "idle" ? true : undefined),
			120_000,
		);

		const asSub = { ...knob, PI_SESSION_ID: bossRecord.id };
		const bounded = spawnPi(w, piArgs(w, "bounded", ["-p", BOUNDED_TASK]), REPO, asSub);
		const patient = spawnPi(w, piArgs(w, "patient", ["-p", PATIENT_TASK]), REPO, asSub);
		const boundedRecord = await waitUntil("bounded online", () => presenceNamed(w, "bounded"), ONLINE_TIMEOUT_MS);
		const patientRecord = await waitUntil("patient online", () => presenceNamed(w, "patient"), ONLINE_TIMEOUT_MS);
		sleeps = await waitUntil(
			"the sleep runs under the bounded sub",
			() => {
				const found = descendantsOf(boundedRecord.pid).filter((proc) => /\bsleep 617\b/.test(proc.command));
				return found.length > 0 ? found : undefined;
			},
			90_000,
			100,
		);
		const seenAt = Date.now();
		const goneAt = await waitUntil("the sleep is gone", () => (sleeps.some((proc) => pidAlive(proc.pid)) ? undefined : Date.now()), 30_000, 100).catch(() => undefined);
		const subLived = pidAlive(boundedRecord.pid) && readPresence(w.store, boundedRecord.id)?.endedAt === undefined;
		const exited = (run: Run): boolean => run.proc.exitCode !== null;
		await waitUntil("both subs exit", () => (exited(bounded) && exited(patient) ? true : undefined), 120_000);
		const [boundedDone, patientDone] = await Promise.all([bounded.done, patient.done]);
		const reports = await waitUntil(
			"both ended reach boss",
			() => {
				const found = inboxOf(w, bossRecord.id).filter((message) => isEnded(message, boundedRecord.id) || isEnded(message, patientRecord.id));
				return found.length >= 2 ? found : undefined;
			},
			10_000,
		).catch(() => inboxOf(w, bossRecord.id).filter((message) => message.kind === "ended"));
		await waitUntil(
			"boss has read both reports and answered",
			() => {
				const entries = sessionEntries(w, bossRecord.id);
				const seen = delivered(entries).filter(({ message }) => message.kind === "ended");
				const last = seen.at(-1)?.index ?? Number.POSITIVE_INFINITY;
				return seen.length >= 2 && assistantTexts(entries).some(({ index }) => index > last) ? true : undefined;
			},
			120_000,
		).catch(() => undefined);
		await waitUntil("boss idle again", () => (readPresence(w.store, bossRecord.id)?.activity === "idle" ? true : undefined), 60_000).catch(() => undefined);
		boss.proc.stdin.end();
		const bossDone = await boss.done;

		const bossEntries = sessionEntries(w, bossRecord.id);
		const boundedEntries = sessionEntries(w, boundedRecord.id);
		const patientEntries = sessionEntries(w, patientRecord.id);
		const bossCalls = toolCalls(bossEntries, "bash") as BashArgs[];
		const bossResult = toolResults(bossEntries, "bash")[0] ?? "";
		const [boundedCall] = toolCalls(boundedEntries, "bash") as BashArgs[];
		const boundedResult = toolResults(boundedEntries, "bash")[0] ?? "";
		const [patientCall] = toolCalls(patientEntries, "bash") as BashArgs[];
		const patientResult = toolResults(patientEntries, "bash")[0] ?? "";
		const killedLine = `Command timed out after ${SHORT_TIMEOUT_MS / 1_000} seconds`;
		const note = timeoutNote(SHORT_TIMEOUT_MS / 1_000);
		const endedFrom = (record: Presence) => reports.filter((message) => isEnded(message, record.id));
		const lastSaid = (entries: readonly Record<string, unknown>[]) => assistantTexts(entries).at(-1)?.text.trim() ?? "(it ended without a final message)";
		const toBoss = inboxOf(w, bossRecord.id);
		checks.push(
			check("boss is top-level; both subs are its subs", bossRecord.parent === undefined && boundedRecord.parent === bossRecord.id && patientRecord.parent === bossRecord.id),
			check(
				"the parent's own bash, with no timeout, got no default: it ran past it and finished",
				bossCalls.length > 0 && bossCalls.every(setsNoTimeout) && bossResult.includes("BOSS-SLEPT") && !bossResult.includes("timed out"),
				`${JSON.stringify(bossCalls)}\n${clip(bossResult)}`,
			),
			check("the bounded sub ran sleep 617 with no timeout of its own", boundedCall?.command?.includes("sleep 617") === true && setsNoTimeout(boundedCall), JSON.stringify(boundedCall)),
			check("its result: timed out at msg's default, then msg's note on the next line", boundedResult.endsWith(`${killedLine}\n${note}`), clip(boundedResult)),
			check("the sleep ran under it and was killed while the sub lived on", goneAt !== undefined && subLived, JSON.stringify({ sleeps, goneAfterMs: goneAt === undefined ? undefined : goneAt - seenAt, subLived })),
			check("it carried on and finished: exit 0, DONE", boundedDone.code === 0 && /\bDONE\b/.test(boundedDone.stdout), `exit ${boundedDone.code}: ${clip(boundedDone.stdout + boundedDone.stderr)}`),
			check(
				"its ended reached boss, not stopped, with its last words",
				endedFrom(boundedRecord).length === 1 && endedFrom(boundedRecord)[0]?.stopped === undefined && endedFrom(boundedRecord)[0]?.text === lastSaid(boundedEntries),
				JSON.stringify(endedFrom(boundedRecord)),
			),
			check("the patient sub's own timeout stood: timeout 20", patientCall?.command?.includes("sleep 4") === true && patientCall.timeout === 20, JSON.stringify(patientCall)),
			check("its sleep 4 outlived msg's default and finished, with no note", patientResult.includes("SLEPT") && !patientResult.includes("timed out") && !patientResult.includes(note), clip(patientResult)),
			check(
				"it finished and reported, not stopped",
				patientDone.code === 0 && endedFrom(patientRecord).length === 1 && endedFrom(patientRecord)[0]?.stopped === undefined,
				`exit ${patientDone.code}: ${JSON.stringify(endedFrom(patientRecord))}`,
			),
			check("no stalled, no died", !toBoss.some((message) => message.kind === "stalled" || message.kind === "died"), JSON.stringify(toBoss.map((message) => [message.kind, message.from.name]))),
			noExtensionErrors(boundedDone.stderr + patientDone.stderr + bossDone.stderr),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		const ours = new Set(sleeps.map((proc) => proc.pid));
		const leftover = ours.size === 0 ? [] : processes().filter((proc) => ours.has(proc.pid) && /\bsleep 617\b/.test(proc.command));
		for (const proc of leftover) process.kill(proc.pid, "SIGKILL");
		w.dispose();
	}
	return report("timeout: a sub's bash call without a timeout dies at msg's default with its note, and the sub carries on; its own timeout and the parent's bash are left be", checks);
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

export const SCENARIOS = { rpcWake, steerBusy, webHost, lineage, wall, nested, stopped, stalled, timeout, quickDeath, offlineDeath } as const;
