# msg

Agent-to-agent messaging for [pi](https://github.com/earendil-works/pi) sessions on one machine.
A pi session can see which other sessions are around, message one by name, block until it answers,
or wait for someone to write. A session that's busy gets the message at its next step; an idle one
wakes up and handles it. Same idea as Amp's `send_to_thread`, Grok Bot's bot-to-bot handoffs and
OpenClaw's `sessions_send`, built for pi: TUI, pi-web, RPC and headless `pi -p` subs alike.

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

## Names

Peers address each other by session name, full session id, or a unique id prefix (≥4 chars).
Name a session with `pi -n builder`, `/name builder`, pi-web's rename, or `msg_list` with `set_name`.
Unnamed sessions are reachable by id. A live name beats an offline one; two live sessions with the
same name are an error that lists both ids.

## Tools

| tool | what it does |
|---|---|
| `msg_list` | you + the live sessions (name · id · mode · busy/idle · cwd · uptime). `all: true` adds offline ones, `set_name` names you first |
| `msg_send` | `to`, `message`; `delivery: steer` (default, next step) or `follow_up` (after its current task); `wait_seconds` blocks for the reply and returns it as the tool result; `reply_to` answers a message |
| `msg_wait` | blocks until a message arrives (`from` filters by sender), up to `timeout_seconds` (default 300, max 3600) |

What the receiving agent sees:

```
<msg id="0mv962x7b-67ef02" from="scout" session="01a13e47-…" cwd="/Users/…/.forks/1">
Should I go ahead and fix finding #2? yes/no
</msg>
Message from another agent session (not your user). scout is blocked waiting for your reply (3m left): answer with msg_send to "01a13e47-…" with reply_to "0mv962x7b-67ef02".
```

The tools' prompt guidelines tell the model that peers aren't its user (the user wins on conflict)
and not to send acknowledgements.

## Delivery rules

- **busy session**: steered in after its current tool calls (`steer`), or queued until it finishes (`follow_up`)
- **idle tui / web / rpc session**: wakes up and runs a turn for the message
- **idle `pi -p` / json run**: never woken (it would collide with the `-p` prompt and it is about to
  exit). Messages wait in its inbox. A headless sub that must stay reachable calls `msg_wait`
- **a tool call waiting** (`msg_send` with `wait_seconds`, `msg_wait`) gets first pick of matching
  messages; they come back as its result instead of entering the conversation
- **wake budget**: a session woken 20 times in 10 minutes without a human prompt stops waking; new
  messages are appended without starting a run until someone prompts it. Two agents that keep
  answering each other run out
- **offline sessions** keep their inbox; it's delivered when the session resumes. `msg_send` says so
- **startup grace**: no wakes in a session's first 3 seconds, so an RPC host's first prompt doesn't collide

## CLI

```
msg ls [--all] [--json]                         who's around
msg send <to> <text...|-> [--wait <secs>] [--reply-to <id>] [--follow-up]
msg inbox [--peek] [--json]                     take the messages waiting for you
msg wait [--from <who>] [--timeout <secs>]      block until a message arrives (exit 124 on timeout)
msg log [<who>] [-n <count>]                    recent messages to and from you
msg whoami
```

Identity: `--id` / `$MSG_ID`, else `$PI_SESSION_ID` (pi sets it in its bash tool, so an agent using
the CLI speaks as its own session), else `cli-$USER`. `--as <name>` names it and sticks. The CLI never
overwrites the record of a live pi session that owns the id. While `send --wait` or `wait` runs it
heartbeats, so peers see it as live and may block on it.

## With pfs subs

```sh
n=$(pfs new api -q --allow ~/.pi/agent/msg)     # the wall must let the sub write the store
pfs run "$n" --bg -q pi -n api-builder -p "$task"
msg send api-builder "stop touching src/db.ts, the migration fork owns it"
```

Tell subs who to talk to in their task ("ask `main` with msg_send wait_seconds if the schema is
unclear", "send `main` a one-line summary when you commit"). A sub that finishes its turn exits; if
it should wait for a go-ahead, say "msg_wait for main's go-ahead before committing".

## Store

`$PI_MSG_DIR`, else `$PI_CODING_AGENT_DIR/msg`, else `~/.pi/agent/msg`; dirs 0700, files 0600.

```
sessions/<session id>.json       presence: name, cwd, pid, mode, busy/idle, heartbeat, endedAt
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
- **pfs walls**: a walled fork can't write `~/.pi/agent/msg` unless created with
  `--allow ~/.pi/agent/msg` (or point `PI_MSG_DIR` at a writable path for everyone)
- **pi-web evicts idle sessions** nobody is viewing after 15 minutes. Their mail waits until the
  session is opened again; nothing reopens it automatically yet
- **crash window**: a message is claimed into `cur/` just before pi takes it; if the process dies in
  that instant, or before pi persists a queued steer, the message is lost (it stays in `cur/` for
  `msg log` but isn't redelivered)
- **trust**: every session on the machine can message every other. Messages are framed as peer
  input, not user instructions, but an agent that read something hostile can still be talked into
  sending a hostile message. Don't give agents that browse untrusted content standing permissions
  you wouldn't give their peers

## Development

```sh
bun run check   # tsc + unit tests (temp stores, never touches ~/.pi)
bun run e2e     # real pi sessions on anthropic/claude-haiku-5-5 (E2E_MODEL to change): rpc wake,
                # headless pair, steer a busy run, two pi-web style SDK sessions in one Bun process
```
