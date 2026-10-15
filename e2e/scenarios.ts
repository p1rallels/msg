import { type AgentSession, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { readPresence } from "../src/core/registry.ts";
import { type Check, check, cli, customMessages, EXTENSION, MODEL, piArgs, presenceNamed, REPO, report, sessionEntries, sleep, spawnPi, THINKING, toolCalls, toolResults, waitUntil, type World, world } from "./lib.ts";

const ONLINE_TIMEOUT_MS = 45_000;
const STARTUP_GRACE_MS = 3_500;

const clip = (text: string, max = 600): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** An idle interactive session wakes up for a message and answers a CLI caller that waits. */
export const rpcWake = async (): Promise<boolean> => {
	const w = world("wake");
	const checks: Check[] = [];
	try {
		const bob = spawnPi(w, piArgs(w, "bob", ["--mode", "rpc"]));
		const record = await waitUntil("bob online", () => presenceNamed(w, "bob"), ONLINE_TIMEOUT_MS);
		await sleep(STARTUP_GRACE_MS);
		const asked = await cli(w, ["send", "bob", "What is 6 times 7? Answer with just the number.", "--wait", "120", "--as", "main"], { MSG_ID: "e2e-main" });
		bob.proc.stdin.end();
		const finished = await bob.done;
		const entries = sessionEntries(w, record.id);
		const sends = toolCalls(entries, "msg_send") as { to?: string; reply_to?: string }[];
		checks.push(
			check("bob shows up live in the registry", record.mode === "rpc", JSON.stringify(record)),
			check("msg send --wait exits 0", asked.code === 0, clip(asked.stdout + asked.stderr)),
			check("the reply carries the answer", /\b42\b/.test(asked.stdout), clip(asked.stdout)),
			check("bob got it as a msg message", customMessages(entries).length >= 1),
			check("bob answered with msg_send to main, reply_to set", sends.some((args) => args.to?.includes("e2e-main") || args.to === "main"), JSON.stringify(sends)),
			check("closing stdin ends bob's presence", readPresence(w.store, record.id)?.endedAt !== undefined),
			check("no extension errors", !/\[msg\]|extension.*error/i.test(finished.stderr), clip(finished.stderr)),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("rpc wake: CLI asks an idle rpc session and waits for the answer", checks);
};

const BOB_TASK = [
	"You are bob, a teammate agent. Another agent session named alice will message you with a question.",
	"First call msg_wait with timeout_seconds 180 to receive it.",
	"Answer it with msg_send: to the sender's session id, reply_to the message id.",
	"What you know: the current build number is 7781.",
	"After sending the answer, reply with the single word DONE.",
].join(" ");

const ALICE_TASK = [
	"You are alice. You need the current build number, and the agent session named bob knows it.",
	"Ask bob with msg_send using wait_seconds 180.",
	"Then reply with just the build number and nothing else.",
].join(" ");

/** Two headless `pi -p` runs: one asks and blocks, the other waits for the question and answers. */
export const headlessPair = async (): Promise<boolean> => {
	const w = world("pair");
	const checks: Check[] = [];
	try {
		const bob = spawnPi(w, piArgs(w, "bob", ["-p", BOB_TASK]));
		const bobRecord = await waitUntil("bob busy", () => {
			const record = presenceNamed(w, "bob");
			return record?.activity === "busy" ? record : undefined;
		}, ONLINE_TIMEOUT_MS);
		const alice = spawnPi(w, piArgs(w, "alice", ["-p", ALICE_TASK]));
		const aliceRecord = await waitUntil("alice online", () => presenceNamed(w, "alice"), ONLINE_TIMEOUT_MS);
		const [aliceDone, bobDone] = await Promise.all([alice.done, bob.done]);
		const aliceEntries = sessionEntries(w, aliceRecord.id);
		const bobEntries = sessionEntries(w, bobRecord.id);
		const aliceSends = toolCalls(aliceEntries, "msg_send") as { wait_seconds?: number }[];
		const bobSends = toolCalls(bobEntries, "msg_send") as { reply_to?: string }[];
		checks.push(
			check("both runs exit 0", aliceDone.code === 0 && bobDone.code === 0, `alice ${aliceDone.code}, bob ${bobDone.code}\n${clip(aliceDone.stderr + bobDone.stderr)}`),
			check("alice's final answer is the build number", aliceDone.stdout.includes("7781"), clip(aliceDone.stdout)),
			check("alice blocked on msg_send with wait_seconds", aliceSends.some((args) => (args.wait_seconds ?? 0) > 0), JSON.stringify(aliceSends)),
			check("bob received it through msg_wait", toolCalls(bobEntries, "msg_wait").length >= 1),
			check("bob answered with reply_to", bobSends.some((args) => Boolean(args.reply_to)), JSON.stringify(bobSends)),
			check(
				"bob was told alice is blocked on his reply",
				toolResults(bobEntries, "msg_send").some((text) => text.includes("blocked waiting for this reply")),
				toolResults(bobEntries, "msg_send").join("\n"),
			),
			check("bob's reply went to alice's tool result, not into her conversation", customMessages(aliceEntries).length === 0),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("headless pair: pi -p alice asks pi -p bob and blocks for the reply", checks);
};

const CAROL_TASK = [
	"Run the bash command `sleep 25` and wait for it to finish.",
	"Then: if a message from another agent session reached you meanwhile, reply with the secret word it contains and nothing else.",
	"If none did, reply NONE.",
].join(" ");

/** A message to a busy headless run is steered into it at its next step. */
export const steerBusy = async (): Promise<boolean> => {
	const w = world("steer");
	const checks: Check[] = [];
	try {
		const carol = spawnPi(w, piArgs(w, "carol", ["-p", CAROL_TASK]));
		const record = await waitUntil("carol busy", () => {
			const found = presenceNamed(w, "carol");
			return found?.activity === "busy" ? found : undefined;
		}, ONLINE_TIMEOUT_MS);
		await sleep(10_000);
		const sent = await cli(w, ["send", "carol", "FYI, the secret word is pineapple.", "--as", "dispatcher"], { MSG_ID: "e2e-dispatcher" });
		const finished = await carol.done;
		const entries = sessionEntries(w, record.id);
		const msgIndex = entries.findIndex((entry) => entry.type === "custom_message" && entry.customType === "msg");
		const bashIndex = entries.findIndex((entry) => toolCalls([entry], "bash").length > 0);
		checks.push(
			check("send reports a busy recipient", sent.stdout.includes("busy; it sees the message at its next step"), clip(sent.stdout + sent.stderr)),
			check("carol exits 0", finished.code === 0, clip(finished.stderr)),
			check("carol's final answer has the secret word", /pineapple/i.test(finished.stdout), clip(finished.stdout)),
			check("the message landed mid-run, after the bash call", msgIndex > bashIndex && bashIndex >= 0, `bash at ${bashIndex}, msg at ${msgIndex}`),
		);
	} catch (error) {
		checks.push(check("scenario ran", false, String(error)));
	} finally {
		w.dispose();
	}
	return report("steer busy: a message reaches a pi -p run mid-task", checks);
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

/**
 * pi-web's shape: several SDK sessions in one Bun process, each with its own copy of the extension,
 * disposed with session.dispose() and no session_shutdown.
 */
export const webHost = async (): Promise<boolean> => {
	const w = world("web");
	const checks: Check[] = [];
	const previousRoot = process.env.PI_MSG_DIR;
	process.env.PI_MSG_DIR = w.store;
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
		const asked = await cli(w, ["send", "web-a", "What is 3+4? Answer with just the number.", "--wait", "120", "--as", "main"], { MSG_ID: "e2e-main" });
		const stillB = readPresence(w.store, recordB.id);
		b.dispose();
		const endedB = await waitUntil("web-b marked ended after dispose", () => readPresence(w.store, recordB.id)?.endedAt, 8_000).catch(() => undefined);
		const aAfterB = readPresence(w.store, recordA.id);
		a.dispose();
		const endedA = await waitUntil("web-a marked ended after dispose", () => readPresence(w.store, recordA.id)?.endedAt, 8_000).catch(() => undefined);
		checks.push(
			check("two sessions, one process, separate identities", recordA.id !== recordB.id && recordA.pid === recordB.pid && recordA.pid === process.pid),
			check("msg send --wait gets the hosted session's answer", asked.code === 0 && /\b7\b/.test(asked.stdout), clip(asked.stdout + asked.stderr)),
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
		w.dispose();
	}
	return report("web host: two SDK sessions in one Bun process, disposed pi-web style", checks);
};

export const SCENARIOS = { rpcWake, headlessPair, steerBusy, webHost } as const;
