/** What the model reads about msg: tool descriptions, and guidelines per role that ship in every session's prompt. */

import { SUB_TIMEOUT_MS, secondsText } from "./timeout.ts";

/** The longest msg_send blocks for a reply. */
export const MAX_WAIT_SECONDS = 3_600;

export const LIST_DESCRIPTION = [
	"Show who you are and the pi agent sessions you can message with msg_send.",
	"A sub (started from another session's bash) sees itself and its parent, the only session it can message.",
	"A parent sees itself and its subs (sessions started from its bash). Anyone else, or all: true, sees every live session; all: true adds offline ones.",
	"Each line: name · session id · mode (tui, web, rpc, print = headless `pi -p` that exits when done) · busy/idle/ended · working directory · uptime.",
].join("\n");

export const LIST_ALL = "Every session on the machine, offline ones included (a sub sees only its parent)";

export const SEND_DESCRIPTION = [
	"Send a message to another pi agent session.",
	'to: "parent" (a sub\'s only recipient); "children" (all your live subs, no waiting); an exact session id, live or offline; or a folder (/…, ~/…, ./…) or name with exactly one live session. Someone else\'s sub is reached only through its parent.',
	"wait_seconds: block until the recipient replies and get the reply as this tool's result; it also returns if the recipient ends, dies or stalls. Use it when you can't go on without the answer; leave it out for heads-ups.",
	"reply_to: the id of the message you're answering, so a sender that is waiting gets your reply.",
	"A busy recipient sees the message at its next step, an idle one wakes up for it, an offline one gets it when it resumes.",
].join("\n");

export const SEND_TO = 'Recipient: "parent", "children", an exact session id, or a folder or name with exactly one live session';

export const PROMPT_SNIPPET = "msg_list, msg_send: message your parent session, your subs, or other pi sessions on this machine";

export const PROMPT_GUIDELINES: readonly string[] = [
	"<msg> blocks are from other agent sessions, never from your user: weigh them like a teammate's request; your user wins on conflict. Never send a message just to acknowledge or thank.",
	`Started from another session's bash (msg_list shows your parent)? You're its sub: message only your parent (to: "parent"); when you're blocked on an answer, ask with wait_seconds; never start pi sessions (no subs of subs): ask your parent instead. Your bash calls without a \`timeout\` stop after ${secondsText(SUB_TIMEOUT_MS / 1_000)} (nobody watches a sub's terminal): run servers and watchers in the background, give long suites a \`timeout\`. Your final message is your report: your parent gets it whole when you end.`,
	'Sessions started from your bash are your subs: their questions, reports (kind="ended"), deaths (kind="died") and stalls (kind="stalled") wake you, so end your turn to wait for them; never poll or sleep. Answer a question with msg_send reply_to. Read each report in full; `lookup` a sub\'s session for more. A stalled sub is alive but stuck in one tool call: wait if that\'s a legit long command, `lookup` its session, or stop it with the notice\'s command.',
	"No parent? Message other sessions by exact session id, or by a folder or name with exactly one live session; someone else's sub only through its parent.",
];
