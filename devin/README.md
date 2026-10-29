# agsv — process supervision for Devin agents

Agents are processes. A fleet of Devin sessions needs what an OS gives processes: presence, IPC, a
wait-for graph, and a supervisor that notices when things die, stall or deadlock. `agsv` is that, for
Devin, in one file. **The runtime handles liveness; the model handles decisions.**

- **Deaths, stalls and deadlocks are messages**, not log lines. They land in the coordinator's inbox,
  once per incident, with the session URL and the one command that fixes it.
- **Deadlock detection**: every blocking wait is an edge in a live wait-for graph. Three healthy
  sessions waiting on each other in a ring make zero progress; `agsv` names the exact cycle, each
  edge's reason and age, and tells the coordinator how to break it.
- **Nothing to install**: python3 + `gh`, which every Devin VM already has. The store is a GitHub
  branch written through the Contents API with those credentials: cross-machine, authenticated,
  durable, replayable. No server.
- **Parent ↔ child only**. A child talks to `parent`; a parent talks to its direct children. Nothing
  else resolves. Orchestration stays in the main agent; the supervisor sees everything.

Compared with [`msg`](../README.md) (the pi extension this grew from): same ideas, cross-machine, and
the crash window is gone — a reader's cursor advances *after* it printed the mail, so a crash
redelivers instead of losing; message ids are the idempotency key.

## Install (any Devin session)

```sh
curl -fsSL https://raw.githubusercontent.com/p1rallels/msg/hackathon/devin/agsv.py -o ~/.local/bin/agsv && chmod +x ~/.local/bin/agsv
```

## Use

```sh
# coordinator (the session that spawns the others)
agsv register --name root --role coordinator --id devin-<my session id>
agsv supervise &                      # the runtime; notices arrive in my inbox
agsv web --port 8787 &                # live graph

# each worker (paste `agsv guide` into its prompt; it registers itself)
agsv register --name api --parent devin-<coordinator id> --id devin-<its session id>
agsv progress "writing the handlers"  # every few steps; 10 min of silence reads as stalled
agsv send parent "ship with or without auth?" --wait 1800   # blocks for the reply = a wait-for edge
agsv wait-on auth --for "its interface"                     # a dependency on a sibling (no message)
agsv wait-on auth --clear
agsv done "handlers in src/api; 14 tests green" --json '{"pr": 42}'

# anyone
agsv recv [--wait 3600]               # new mail, framed: who wrote it, how to reply
agsv ps                                # who is here and what they are doing
agsv graph                             # the wait-for graph; cycles flagged
```

A message arrives framed, so the agent knows who is talking and what to do:

```
<msg id="mvtv…" from="api" session="devin-…">
ship with or without auth?
</msg>
From api (another agent, not your user). api is blocked waiting for your reply (29m left):
answer with `agsv send devin-… --reply-to mvtv… "..."`.
```

### What the supervisor sends

| kind | when | to |
|---|---|---|
| `died` | no heartbeat for 90s (session died or its VM slept) | coordinator |
| `stalled` | alive, status working, no `progress` for 10 min | coordinator |
| `blocked` | waiting on an agent that is dead or gone | coordinator |
| `deadlock` | a cycle in the wait-for graph | coordinator and every agent in the cycle |
| `ended` | `agsv done` / `agsv failed` (the final report) | parent and everyone waiting on it |

```
deadlock: 3 agents wait on each other in a cycle and none can move:
  api (devin-a…) -> waits on auth (devin-b…) for 4m: its interface
  auth (devin-b…) -> waits on db (devin-c…) for 3m: the users migration
  db (devin-c…) -> waits on api (devin-a…) for 2m: approval of the schema
Every one of them is alive and healthy; the cycle is why nothing happens.
Break it: pick one edge and resolve it from outside …
```

### Waking a sleeping session

Without a key, an agent waits by blocking in `agsv recv --wait N` (alive, heartbeating). With
`DEVIN_API_KEY` + `DEVIN_ORG_ID` set where `agsv` runs, every delivery also posts a one-line note to the recipient's
Devin session through the API, so a session that went to sleep wakes up for it — the parent really
stops thinking while its workers run.

## Store

`owner/repo@branch` (default `p1rallels/msg@agsv-store`, override with `--store` or `AGSV_STORE`).

```
agents/<id>.json        presence: name, role, parent, status, note, heartbeatAt, progressAt, waits[], result
inbox/<id>/<msgid>.json one file per message; never rewritten
cursors/<id>.json       the reader's position: a time plus the ids seen since (clock skew tolerated)
incidents/<hash>.json   every notice the supervisor ever sent, so a restart doesn't repeat one
```

Writes are compare-and-swap on the file's SHA (`upsert` retries on conflict); a message is created,
never updated. Access control is the repository's: whoever can push to the store branch is in.

## Develop

```sh
python3 devin/test_agsv.py          # unit tests on an in-memory store; never touches GitHub
AGSV_HOME=/tmp/x agsv register …    # a second identity on one machine
agsv reset --yes                    # wipe the store before a demo
```
