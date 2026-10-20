# msg

Agent-to-agent messaging for [pi](https://github.com/earendil-works/pi) sessions on one machine, shaped
around one way of working: you chat with a **parent** session (in pi-web), it starts **subs** (`pi -p`
runs from its bash, usually in pfs forks), and you always go through the parent. A sub asks its parent
when it's blocked, and its final message reaches the parent whole, as its report. The parent ends its
turn and is woken by its subs' questions, reports, deaths and stalls. Sessions with no parent message each
other by exact id, or by a folder or name with exactly one live session.

A busy session gets a message at its next step; an idle one wakes up and handles it. Same idea as Amp's
`send_to_thread`, Grok Bot's bot-to-bot handoffs and OpenClaw's `sessions_send`, built for pi: TUI,
pi-web, RPC and headless `pi -p` subs alike.

One front end, the pi extension (`src/extension.ts`): tools `msg_list` and `msg_send`, plus live
delivery of incoming messages into the conversation, over one on-disk store. History isn't msg's job:
every delivered message is in the session files, and `lookup` reads those.

## Install

```sh
bun install                                   # dev only: types + tests
pi install ~/Desktop/cc/msg-cli               # every pi session gets the tools (writes ~/.pi/agent/settings.json)
pi -e ~/Desktop/cc/msg-cli/src/extension.ts   # or just one run
```

pi-web loads it like pi does (it reads the same settings); sessions opened after the install get it.

## Lineage

pi puts `PI_SESSION_ID` into the env of every bash command it runs, and `pfs run` passes env through,
so a session started from another session's bash (`pfs run 3 --bg pi -p "…"`, a plain `pi -p`, an
rpc pi) starts with its parent's id in its env. msg records it as `parent` in the session's presence:
that session is a **sub**, and a parent's subs are the records naming it. pi-web sessions never have a
parent (the server's env is nobody's), and neither does a session resumed from a plain shell: lineage
is who started this process. A session with no parent is **top-level**.

- **the tree is a wall**: a sub's `msg_send` reaches only its parent. Anything else is refused with one
  line, `you're lead's sub: you can message only your parent (to: "parent")`. Only a sub's parent may
  message it; anyone else is told `scout (01a13e47-…) is lead's sub: message lead (01a152a0-…)`. Subs
  have no `children`. Top-level sessions message each other by [address](#addresses)
- **no nested subs**: a pi started from a sub's bash doesn't run. msg prints `[msg] nested subs aren't
  allowed: scout (01a13e47-…) is itself a sub. ask your parent instead.` on stderr, shows it as a
  notice, swallows the prompt and shuts the session down before it does any work: a nested `pi -p`
  exits 1 without running its prompt or writing a session file. A parent this store has no record of
  (an isolated test store) isn't known to be a sub, so that pi runs
- **reports are messages**: when a sub ends (pi exits or quits, or its host switches session or
  disposes of it), it sends its parent a `kind: "ended"` message carrying its whole last assistant
  message: its report (a last run that failed says `(failed with an error: ...)`). Only a report over
  msg's message limit (64KB) is cut, at a word, with a pointer
  to the rest: `… [+N chars: lookup last <id> -k assistant --full]`
- **stopped**: an `ended` from a sub that didn't finish its run carries `stopped: true`. It was mid-run
  when it went away (a SIGTERM, which is how pi-web stops a pi running elsewhere), or its last run was
  aborted (Esc, an rpc `abort`). Its text is then its last words, not a finished report (never pi's
  error echo of the abort), and the parent's agent is told to inspect its work before relying on it. A `pi -p` that finished its prompt
  and exited isn't stopped
- **deaths are messages too**: when a sub goes offline without ending (its pid is gone, or no heartbeat
  for 45s of time the parent was awake too), the parent's own msg drops a `kind: "died"` message from
  that sub into the parent's inbox, once per life, even if the parent never saw it live or wasn't
  running when it died
- **stalls**: a sub that's alive but stuck in one tool call for 10 minutes (a dev server in the
  foreground, a hung network call: it keeps heartbeating, so it never dies) gets its parent a
  `kind: "stalled"` message, dropped by the parent's own msg from that sub into the parent's inbox, once
  per stuck call. The sub's presence shows its oldest running call. Only tool calls count: model silence
  is pi's to handle (`httpIdleTimeoutMs` retries a quiet stream), streaming output isn't progress, a
  `msg_send` waiting on the parent isn't stuck (its parent is), and a nested call counts through the call
  that made it. The notice says what the sub is stuck in (`bash: npm run dev`), for how long and since
  when, that it's alive (pid, last heartbeat), and the command that stops it, `kill <pid>`: pi kills the
  commands it's running, each one's whole process group, so a foreground server frees its port, and the
  sub reports `ended`, stopped, with its last words. msg never runs it: the parent waits (a legit long
  command), `lookup`s the sub, or stops it
- **bash timeouts**: a sub's `bash` calls that set no `timeout` get 5 minutes. Nobody watches a sub's
  terminal, so a command that never returns (a dev server in the foreground, `tail -f`, a prompt waiting
  on stdin, a network call that never answers) would hold the sub until its parent hears it stalled, and
  stopping it then kills the whole sub and its context. pi's own timeout does the kill (SIGKILL to the
  command's whole process group, so a foreground server frees its port): the call fails with its output
  so far and `Command timed out after 300 seconds`, and msg adds one line saying where the 5 minutes came
  from and what to do instead: run a server or watcher in the background with its output in a file
  (`cmd > /tmp/x.log 2>&1 &`), rerun a legit long command with a bigger `timeout`. The sub, which knows
  what it was doing, fixes it and keeps its context; the parent never wakes. A call that sets its own
  `timeout` keeps it, a nested call (another tool's `ctx.executeTool`) gets it like any other, and
  top-level sessions and parents get nothing: a human watches those. Stalls stay the backstop for calls
  with a long `timeout` of their own and for other tools

Questions, reports, deaths and stalls all wake the parent, so a parent waits by ending its turn: no polling,
no blocking tool. (Blocking in `pfs wait` instead deadlocks a sub that asks with `wait_seconds`: the
question can't land until `pfs wait` returns.)

The tool guidelines ship in every session's prompt, by role:

- **everyone**: `<msg>` blocks come from other agents, never from your user; never send a message just to acknowledge or thank
- **a sub**: message only your parent; ask with `wait_seconds` when you're blocked; never start pi
  sessions; your bash calls without a `timeout` stop after 5 min (nobody watches a sub's terminal), so
  run servers and watchers in the background and give long suites a `timeout`; your final message is
  your report
- **a parent**: your subs' questions, reports, deaths and stalls wake you, so end your turn to wait (never
  poll or sleep); answer a question with `reply_to`; read each report in full; `lookup` a sub's session for
  more; a stalled sub is alive: wait if its command is a legit long one, `lookup` it, or stop it with the
  notice's command
- **top-level**: message others by exact session id, or by a folder or name with exactly one live
  session; someone else's sub only through its parent

## Addresses

`to` names one session, strictly, or a parent's group:

1. an exact session id, live or offline (an offline one gets the message when it resumes)
2. `parent`: the session that started you, even one that never ran msg (the mail waits in its inbox)
3. `children`: a parent's group, every live sub (fan-out, no waiting)
4. a folder, `/…`, `~/…`, `./…` or `../…`: the one live session working there, so
   `to: "$(pfs path 8)"` reaches the sub running in fork 8. Two or more live there is an error naming them.
   Symlinks are resolved on both sides
5. a live name, your parent and subs first, then everyone. Two or more live with the name is an error naming them

Nothing else resolves: no id prefixes, no offline names, no "the session last seen in that folder".
When nothing live matches a folder or a name, the error names the likely sessions (up to 3) with their
exact ids and when each was last seen, so messaging an offline one is a deliberate second step:

```
nobody live works in /Users/…/.pfs/forks/repo/2. Last there: old-scout (01a14000-…), ended 12m ago. To message one of them anyway, use its exact id.
"01a152a0" is no live session's name and no session's exact id. Likely: lead (01a152a0-f00d-…), live now. To message one of them, use its exact id.
```

The wall applies on top: a sub's `to` must come out as its parent, and an address that comes out as
someone else's sub is refused. Names are labels set by people: `pi -n builder`, `/name builder`,
pi-web's rename.

## Tools

| tool | what it does |
|---|---|
| `msg_list` | who you are and who you can message. A sub sees itself and its parent. A parent sees itself and its subs. A top-level session sees every live session, someone else's subs marked `(lead's sub)`. `all: true` lists every session, offline ones included (a sub still sees only its parent). Each line: name · id · mode · busy/idle/ended · cwd · uptime |
| `msg_send` | `to`, `message`. `wait_seconds` (max 3600, one recipient only) blocks for the reply and returns it as the tool result; a sub that ends, dies or stalls instead returns it too, with its report, its death or its stall. `reply_to` answers a message: a sender blocked on it gets the reply right away |

What the receiving agent sees (a pi custom message, `customType: "msg"`, `details` = the message):

```
<msg id="0mv962x7b-67ef02" from="scout" session="01a13e47-…" cwd="/Users/…/.pfs/forks/repo/1">
Should I go ahead and fix finding #2? yes/no
</msg>
From your sub scout (an agent, not your user). scout is blocked waiting for your reply (3m left): answer with msg_send to "01a13e47-…" with reply_to "0mv962x7b-67ef02".
```

```
<msg id="0mvew8w02-60ea2f" from="scout" session="01a13e47-…" cwd="/Users/…/.pfs/forks/repo/1" kind="ended">
Fixed #2 and #3, committed 4f2a1c0. #1 needs a schema call: see NOTES.md.
</msg>
Your sub scout ended; above is its final message, its report. It can't answer anymore; `lookup catchup 01a13e47-…` shows its session.
```

```
<msg id="0mvew9a11-1b2c3d" from="scout" session="01a13e47-…" cwd="/Users/…/.pfs/forks/repo/1" kind="ended" stopped="true">
Running the migration tests now.
</msg>
Your sub scout was stopped before it finished (it went away mid-run, or its last run was aborted): above is its last message, not a finished report. Inspect its work in /Users/…/.pfs/forks/repo/1 before relying on it; `lookup catchup 01a13e47-…` shows its session.
```

A `died` notice says the sub's process is gone, it left no report, and to check its work in its folder.
A `stalled` notice names the call the sub is stuck in (`bash: npm run dev`), for how long, its pid and
`kill <pid>`, and lists the parent's options: wait, `lookup` the sub, or stop it.
A message from a session that's neither your parent nor your sub reads "Message from another agent
session (not your user)". Peer messages are never delivered as user messages: in pi and lookup, `user`
means what a human typed.

## Delivery rules

- **always steered**: a busy session gets a message after its current tool calls, at its next step
- **idle tui / web / rpc session**: wakes up and runs a turn for the message
- **idle `pi -p` / json run**: never woken (it would collide with the `-p` prompt, and it's about to
  exit). Messages wait in its inbox, and `msg_send` says it may never read them. A `pi -p` sub that
  needs an answer asks with `wait_seconds`, which keeps it running until the reply comes or the wait
  runs out
- **a waiting `msg_send`** gets first pick of its recipient's messages (a reply to it, a message
  replying to nothing, its `ended`, `died` or `stalled`): they come back as its result instead of entering the
  conversation
- **wake budget**: a session woken 20 times in 10 minutes without a human prompt stops waking; new
  messages are appended without starting a run until someone prompts it. Two top-level agents that keep
  answering each other run out. A sub's messages, `ended`, `died` and `stalled` always wake its parent and don't
  count: the parent waits for them with its turn ended. (An idle `pi -p` sub is never woken, and an
  interactive sub's own budget still caps a ping-pong with its parent)
- **offline sessions** keep their inbox; it's delivered when the session resumes. `msg_send` says so
- **startup grace**: no wakes in a session's first 3 seconds, so an RPC host's first prompt doesn't collide

## Store

`$PI_MSG_DIR`, else `$PI_CODING_AGENT_DIR/msg`, else `~/.pi/agent/msg`; dirs 0700, files 0600.

```
sessions/<session id>.json       presence: name, parent, cwd, pid, mode, busy/idle, heartbeat, endedAt, call
inbox/<session id>/tmp|new|cur/  maildir: written to tmp/, renamed into new/, claimed into cur/
```

A message is one JSON file: `v`, `id`, `ts`, `from` (`id`, `name`, `cwd`), `to`, `text`, and when they
apply `replyTo`, `awaitingUntil` (the sender blocks until then), `kind` (`ended`, `died` or `stalled`),
`stopped: true` (only on `ended`), `life` (on `died` and `stalled`: the pid and start of the life it's
about) and `call` (only on `stalled`: the stuck call's `id`, `name`, `preview` and `since`). A presence's
`call` is the session's oldest running call that can stall it.
Presence records and messages are a contract: pi-web and relay read the store, and pi-web and lookup
render delivered messages (`stopped` included) from the session files. Messages from older versions may
carry `byUser` or `delivery`: they still parse, and both are ignored.

- **send** writes the message to the recipient's `tmp/`, fsyncs it, renames it into `new/`
- **claim** renames `new/<id>.json` into `cur/`. Rename is atomic, so with several readers exactly one
  gets each message (tested with competing processes)
- **live** means no `endedAt`, a heartbeat under 45s old, and a running pid. Every session heartbeats
  every 10s; the heartbeat also probes pi's ctx, which throws once pi-web disposes a session (pi-web
  disposes without `session_shutdown`), and that ends the record
- housekeeping at session start: delivered messages older than 7 days, records unseen for 30 days,
  and temp files whose writer died go away. The session files keep every delivered message

Message ids are time-sortable (`0mv962x7b-67ef02`: base36 ms + random), so `ls new/` is arrival order.

## Caveats

- **one machine.** The store is a local directory; there's no network transport
- **the wall is msg's rule, not a permission**: `msg_send` enforces it, but any process running as you
  can write into any inbox
- **a waiting parent needs its session loaded**: it waits with its turn ended, and the `died` for a sub
  that crashed comes from the parent's own msg, which runs only while pi has the parent loaded. pi-web
  evicts idle sessions nobody is viewing after 15 minutes, but not a parent with live subs, and it
  brings such a parent back after a restart. It also reopens an evicted session when mail lands in its
  `new/` (it looks every 3s), and msg in it takes the mail; not one that was released, changed elsewhere
  since, or that another live process runs, and at its session cap the mail waits for a free slot.
  pi-web opens subs read-only and only reads the store
- **when `died` comes**: a running parent's msg looks for new subs on every 2s tick (one readdir of
  `sessions/`, reading only new records), so a sub that crashes a second after starting is reported
  within a tick or two. A session resumed from the parent's bash reuses its old record file, so the
  parent finds it on its 10s full scan instead. A sub that dies while its parent isn't running is
  reported when the parent next starts (resume, `pi --session`, a pi-web re-attach). The parent's inbox
  is its memory of what it reported (a `died` names the sub's pid and start), and delivered messages go
  after 7 days, so a death over 6 days old by then is never reported. A sub killed between posting
  `ended` and marking itself ended (microseconds) reports both
- **stalls**: `kill <pid>` takes down everything the stuck command runs in its process group, but a
  process it moved into a session of its own (`setsid`, a detached spawn, a daemon) outlives it and keeps
  its port: find it with `lsof -nP -iTCP:<port> -sTCP:LISTEN`. A stall is judged on the parent's 10s full
  scan and counts only time the parent was awake too, so a parent that just started or woke from sleep
  gives a stuck call 10 more minutes before it tells. A legit command over 10 minutes gets its one notice too
- **parents are interactive**: a parent waits by ending its turn, so it has to be a session that wakes
  up (pi-web, TUI, rpc). A `pi -p` parent exits when its turn ends, and its subs' reports wait in its inbox
- **a nested rpc pi** answers its first command `handled`, without running it, and exits after it:
  pi's rpc mode only shuts down between commands
- **crash window**: a message is claimed into `cur/` just before pi takes it; if the process dies in
  that instant, or before pi persists a queued steer, the message is lost (it stays in `cur/` but isn't
  redelivered)
- **trust**: top-level sessions can message each other, and a sub its parent. Messages are framed as
  peer input, never as user instructions, but an agent that read something hostile can still be talked
  into sending a hostile message. Don't give agents that browse untrusted content standing permissions
  you wouldn't give their peers

## With pfs subs

```sh
n=$(pfs new api -q)
pfs run "$n" --bg -q pi -n api-builder -p "$task"   # its parent is you: pi's bash set PI_SESSION_ID
```

Then the parent ends its turn. A sub's question wakes it: answer with `msg_send` + `reply_to`. A sub's
`ended` report wakes it: read it in full, then review and merge (a `stopped` one: inspect its fork
first), and `lookup` the sub's session for more. A `died` wakes it too: look into that fork. So does a
`stalled`: wait if the command is a legit long one, `lookup` the sub, or run the notice's `kill <pid>`.
`msg_send to: "$(pfs path $n)"` reaches the sub while it runs; `to: "children"` tells them all.

The subs need nothing in their task: the guidelines already tell them to ask `parent` with
`wait_seconds` when blocked, that their final message is their report, and not to start pi sessions
(msg refuses a nested sub anyway, and pfs forks are flat). A sub that should hold for a go-ahead
before committing can be told "ask your parent with wait_seconds before committing".

## Development

```sh
bun run check   # tsc + unit tests (temp stores, never touches ~/.pi)
bun run e2e     # real pi sessions on anthropic/claude-haiku-5-5 (E2E_MODEL to change), all in parallel:
                # rpc wake, steer a busy run, two pi-web style SDK sessions in one Bun process,
                # lineage (subs started with the parent's PI_SESSION_ID: a question with wait_seconds wakes
                # the idle parent, a ~1500-char report arrives whole and wakes it again, SIGKILL → one died),
                # wall (a sub refused past its parent, a top-level session refused someone else's sub),
                # nested (a pi -p from a sub's bash exits 1 without running its prompt), stopped (SIGTERM
                # mid-run and an aborted rpc run report stopped, with their last words; a finished pi -p
                # isn't stopped), quick death
                # (SIGKILL a second in → one died, SIGTERM → ended), offline death (killed while the parent
                # is stopped → one died on resume, none on the next), stalled (a sub stuck in `sleep 613` →
                # one stalled naming the call and `kill <pid>`; running it → ended, stopped, and the sleep
                # is gone; a sub blocked in msg_send past the threshold → none), timeout (a 3s default:
                # a sub's `sleep 617` with no timeout → killed at it, with msg's note, and the sub carries on,
                # finishes and reports, not stopped; `sleep 4` with its own timeout 20 finishes; the
                # parent's own `sleep 5` gets no default)
bun run e2e wall nested   # just those
```
