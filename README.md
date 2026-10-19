# msg

Agent-to-agent messaging for [pi](https://github.com/earendil-works/pi) sessions on one machine.
A pi session can see which other sessions are around, message one, block until it answers, or wait
for someone to write. A session that's busy gets the message at its next step; an idle one wakes up
and handles it. Same idea as Amp's `send_to_thread`, Grok Bot's bot-to-bot handoffs and OpenClaw's
`sessions_send`, built for pi: TUI, pi-web, RPC and headless `pi -p` subs alike.

Sessions know their family: a session started from another session's bash is its **child**, and
that session its **parent**. A child talks to `parent`; a parent hears from `children`, including
when one finishes (`ended`, with its final message) or vanishes (`died`).

Two front ends over one on-disk store:

- **the pi extension** (`src/extension.ts`): tools `msg_list`, `msg_send`, `msg_wait`, plus live
  delivery of incoming messages into the conversation
- **the `msg` CLI** (`src/cli.ts`): the same store from a shell, for humans, scripts, and any agent
  with a bash tool

## Install

```sh
bun install                              # dev only: types + tests
pi install ~/Desktop/cc/msg-cli          # every pi session gets the tools (writes ~/.pi/agent/settings.json)
pi -e ~/Desktop/cc/msg-cli/src/extension.ts   # or just one run
alias msg='bun ~/Desktop/cc/msg-cli/src/cli.ts'
```

pi-web loads it like the CLI does (it reads the same settings); sessions opened after the install get it.

## Lineage

pi puts `PI_SESSION_ID` into the env of every bash command it runs, and `pfs run` passes env through,
so a session started from another session's bash (`pfs run 3 --bg pi -p "…"`, a plain `pi -p`, an
rpc pi) starts with its parent's id in its env. msg records it as `parent` in the session's presence;
a session's children are the records naming it as their parent. pi-web sessions never have a parent
(the server's env is nobody's), and neither does a session resumed from a plain shell: lineage is who
started this process.

- **family first**: `msg_list` (and `msg ls`) shows you, your parent and your children. `all: true`
  lists the whole machine; a session with no family sees everyone
- **exits are messages**: when a child ends (pi exits or quits, or its host switches session or
  disposes of it) it sends its parent a `kind: "ended"` message whose text is its last assistant message
  (cut near 600 chars, with a pointer to the rest). When a child goes offline without ending (its pid
  is gone, or no heartbeat for 45s of time the parent was awake too), the parent's own msg drops a
  `kind: "died"` message from that child into the parent's inbox, once per life, even if the parent
  never saw it live or wasn't running when it died. Both are delivered like any message: a waiting
  `msg_wait` takes them, a busy parent gets them steered in, an idle one wakes up
- **words, not walls**: anyone can still message anyone. The tool guidelines (they ship in every
  session's prompt) say: if you have a parent, talk only to it (siblings coordinate through it), ask
  with `wait_seconds` when you're blocked, never acknowledge, and your final message is your report
  (your parent gets it as `ended`). A parent answers and steers; it doesn't chat

So an orchestrator blocks on one thing, `msg_wait from: "children"`, and it returns on a child's
question, a finished child's report, or a dead child. (Blocking in `pfs wait` instead deadlocks a
child that asks with `wait_seconds`: the question can't land until `pfs wait` returns.)

## Addresses

`to` (and `from` in `msg_wait`), in this order:

1. an exact session id
2. `parent`: the session that started you (even one that never ran msg: the mail waits in its inbox)
3. a folder, `/…`, `~/…`, `./…` or `../…`: the live session working there, so
   `to: "$(pfs path 8)"` works. Two live there is an error that lists both; nobody live there means
   the session last seen there. Symlinks are resolved on both sides
4. a live name, your parent and children first, then everyone. Two live with the name is an error
5. a unique id prefix (≥4 chars)
6. the most recently seen offline session with that name

`children` is a group: `msg_send` fans out to every live child (no waiting), `msg_wait` takes any
child's message. Names are labels: `pi -n builder`, `/name builder`, pi-web's rename, or `msg_list`
with `set_name`.

## Tools

| tool | what it does |
|---|---|
| `msg_list` | you, your parent and your children (name · id · mode · busy/idle/ended · cwd · uptime). `all: true` lists every session, offline ones included; `set_name` names you first |
| `msg_send` | `to`, `message`; `delivery: steer` (default, next step) or `follow_up` (after its current task); `wait_seconds` blocks for the reply and returns it as the tool result (a child that ends or dies instead unblocks it too); `reply_to` answers a message |
| `msg_wait` | blocks until a message arrives (`from` filters: `parent`, `children`, a folder, a session), up to `timeout_seconds` (default 300, max 3600) |

And a command for the human, in any session (TUI or pi-web): **`/msg <to> <text>`** sends `text`
as you, the user, from that session. It's marked `byUser: true`, the receiver frames it as its
user's own instruction (sent from that session), and it doesn't start a turn where you typed it.
`/msg` alone shows the usage and your family.

What the receiving agent sees (a pi custom message, `customType: "msg"`, `details` = the message):

```
<msg id="0mv962x7b-67ef02" from="scout" session="01a13e47-…" cwd="/Users/…/.pfs/forks/repo/1">
Should I go ahead and fix finding #2? yes/no
</msg>
From your child session scout (an agent, not your user). scout is blocked waiting for your reply (3m left): answer with msg_send to "01a13e47-…" with reply_to "0mv962x7b-67ef02".
```

```
<msg id="0mvew8w02-60ea2f" from="scout" session="01a13e47-…" cwd="/Users/…/.pfs/forks/repo/1" kind="ended">
Fixed #2 and #3, committed 4f2a1c0. #1 needs a schema call: see NOTES.md.
</msg>
Your child session scout ended; above is its final message (its report). It can't answer until it's resumed.
```

A `died` notice says the child's process is gone and to check its folder; a `/msg` from the user
carries `sent_by="user"` and "From your user via main, not from an agent". Peer messages are never
delivered as user messages: in pi and lookup, `user` means what a human typed.

## Delivery rules

- **busy session**: steered in after its current tool calls (`steer`), or queued until it finishes (`follow_up`)
- **idle tui / web / rpc session**: wakes up and runs a turn for the message
- **idle `pi -p` / json run**: never woken (it would collide with the `-p` prompt and it is about to
  exit). Messages wait in its inbox. A headless sub that must stay reachable calls `msg_wait`
- **a tool call waiting** (`msg_send` with `wait_seconds`, `msg_wait`) gets first pick of matching
  messages; they come back as its result instead of entering the conversation
- **wake budget**: a session woken 20 times in 10 minutes without a human prompt stops waking; new
  messages are appended without starting a run until someone prompts it. Two agents that keep
  answering each other run out. `ended` and `died` notices don't count against it
- **offline sessions** keep their inbox; it's delivered when the session resumes. `msg_send` says so
- **startup grace**: no wakes in a session's first 3 seconds, so an RPC host's first prompt doesn't collide

## CLI

```
msg ls [--all] [--json]                         you, your parent and children (--all: everyone)
msg send <to> <text...|-> [--wait <secs>] [--reply-to <id>] [--follow-up]
msg inbox [--peek] [--json]                     take the messages waiting for you
msg wait [--from <who>] [--timeout <secs>]      block until a message arrives (exit 124 on timeout)
msg log [<who>] [-n <count>]                    recent messages to and from you
msg whoami
```

`<to>` and `--from` take the same addresses as the tools, `parent` and `children` included.

Identity: `--id` / `$MSG_ID`, else `$PI_SESSION_ID` (pi sets it in its bash tool, so an agent using
the CLI speaks as its own session, family and all), else `cli-$USER`. `--as <name>` names it and
sticks. The CLI never overwrites the record of a live pi session that owns the id. While `send --wait`
or `wait` runs it heartbeats, so peers see it as live and may block on it. Run outside pi (no
`$PI_SESSION_ID`), `msg send` marks the message `byUser`: a human typed it.

## With pfs subs

```sh
n=$(pfs new api -q)
pfs run "$n" --bg -q pi -n api-builder -p "$task"   # its parent is you: pi's bash set PI_SESSION_ID
```

Then, as the orchestrator: `msg_wait from: "children"` (answer a question with `msg_send` +
`reply_to`, review and merge a sub whose `ended` report came in, look into one that `died`), repeat.
`msg_send to: "$(pfs path $n)"` reaches the sub working in that fork; `to: "children"` tells them all.
The subs need nothing in their task: the guidelines already say to ask `parent` with `wait_seconds`
when blocked, and their final message reaches you as their report. A sub that should hold for a
go-ahead before committing can be told "msg_wait from parent before committing".

## Store

`$PI_MSG_DIR`, else `$PI_CODING_AGENT_DIR/msg`, else `~/.pi/agent/msg`; dirs 0700, files 0600.

```
sessions/<session id>.json       presence: name, parent, cwd, pid, mode, busy/idle, heartbeat, endedAt
inbox/<session id>/tmp|new|cur/  maildir: written to tmp/, renamed into new/, claimed into cur/
```

- **send** writes the message to the recipient's `tmp/`, fsyncs it, renames it into `new/`
- **claim** renames `new/<id>.json` into `cur/`. Rename is atomic, so with several readers exactly one
  gets each message (tested with competing processes)
- **live** means no `endedAt`, a heartbeat under 45s old, and a running pid. Every session heartbeats
  every 10s; the heartbeat also probes pi's ctx, which throws once pi-web disposes a session (pi-web
  disposes without `session_shutdown`), and that ends the record
- housekeeping at session start: delivered messages older than 7 days, records unseen for 30 days,
  and temp files whose writer died go away

Message ids are time-sortable (`0mv962x7b-67ef02`: base36 ms + random), so `ls new/` is arrival order.

## Caveats

- **one machine.** The store is a local directory; there's no network transport
- **when `died` comes**: a running parent's msg looks for new children on every 2s tick (one readdir
  of `sessions/`, reading only new records), so a child that crashes a second after starting is
  reported within a tick or two. A session resumed from the parent's bash reuses its old record file,
  so the parent finds it on its 10s full scan instead. A child that dies while its parent isn't
  running is reported when the parent next starts (resume, `pi --session`, a pi-web re-attach). The
  parent's inbox is its memory of what it reported (a `died` names the child's pid and start), and
  delivered messages go after 7 days, so a death over 6 days old by then is never reported. A child
  killed between posting `ended` and marking itself ended (microseconds) reports both
- **pi-web evicts idle sessions** nobody is viewing after 15 minutes. It lists their `new/` every
  3s and reopens one (no viewer) when mail lands, and msg in it takes the mail; not one that was
  released, changed elsewhere since, or that another live process runs, and at its session cap the
  mail waits for a free slot. pi-web only reads the store. A session blocked in `msg_wait` is busy,
  not idle, so an orchestrator waiting on its children stays
- **crash window**: a message is claimed into `cur/` just before pi takes it; if the process dies in
  that instant, or before pi persists a queued steer, the message is lost (it stays in `cur/` for
  `msg log` but isn't redelivered)
- **trust**: every session on the machine can message every other. Messages are framed as peer
  input, not user instructions, but an agent that read something hostile can still be talked into
  sending a hostile message. Don't give agents that browse untrusted content standing permissions
  you wouldn't give their peers. `byUser` is a claim, not proof: the CLI makes it whenever
  `$PI_SESSION_ID` is unset, so an agent that unsets it can pass its words off as yours

## Development

```sh
bun run check   # tsc + unit tests (temp stores, never touches ~/.pi)
bun run e2e     # real pi sessions on anthropic/claude-haiku-5-5 (E2E_MODEL to change): rpc wake,
                # headless pair, steer a busy run, two pi-web style SDK sessions in one Bun process,
                # lineage (children started with the parent's PI_SESSION_ID: ask, ended, died, /msg),
                # quick death (SIGKILL a second in → one died, SIGTERM → ended), offline death (killed
                # while the parent is stopped → one died on resume, none on the next)
```
