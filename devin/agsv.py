#!/usr/bin/env python3
"""agsv: process supervision for Devin agents.

Agents are processes. agsv gives a fleet of Devin sessions what an OS gives processes: presence
(heartbeat, status, progress), IPC (a maildir), a wait-for graph, and a supervisor that turns deaths,
stalls and deadlocks into messages a coordinator can act on. The runtime handles liveness; the model
handles decisions.

One file, stdlib only. The store is a GitHub branch written through the Contents API with the `gh`
credentials every Devin session already has: cross-machine, authenticated, durable, replayable.

    agsv register --name api --role worker --parent devin-...   # who you are
    agsv send auth "need your interface" --wait 1800            # ask and block (a wait-for edge)
    agsv recv --wait 3600                                       # block until mail lands
    agsv supervise --coordinator devin-...                      # the runtime
    agsv graph | agsv web                                       # the live wait-for graph
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import random
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

VERSION = 1
DEFAULT_STORE = "p1rallels/msg@agsv-store"
HOME = Path(os.environ.get("AGSV_HOME", "~/.agsv")).expanduser()
HEARTBEAT_S = 20
DEAD_AFTER_S = 90
STALL_AFTER_S = 600
POLL_S = 3
MAX_TEXT = 64 * 1024
MAX_NAME = 64
PREVIEW = 100
SUPERVISOR = {"id": "supervisor", "name": "supervisor"}
RAW_URL = "https://raw.githubusercontent.com/p1rallels/msg/hackathon/devin/agsv.py"


def now_ms() -> int:
    return int(time.time() * 1000)


def b36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or "0"


_SEQ = iter(range(1 << 30))


def new_id() -> str:
    """Time-sortable: base36 ms, a per-process sequence, random hex. Sorting ids is arrival order."""
    return f"{b36(now_ms())}-{next(_SEQ) % 1296:02d}{random.getrandbits(20):05x}"


def clip(text: str, n: int = PREVIEW) -> str:
    line = " ".join(text.split())
    return line if len(line) <= n else line[: n - 1].rstrip() + "…"


def ago(ts: Optional[int], now: int) -> str:
    if not ts:
        return "never"
    s = max(0, (now - ts) // 1000)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    return f"{s // 3600}h{(s % 3600) // 60:02d}m"


def utc(ts: int) -> str:
    return time.strftime("%H:%M:%SZ", time.gmtime(ts / 1000))


class Conflict(Exception):
    """A compare-and-swap lost: the file changed under us, or already exists."""


# ---------------------------------------------------------------- store: a maildir on a GitHub branch


class GitHubStore:
    """`agents/`, `inbox/<id>/`, `cursors/`, `incidents/` on one branch. Every write is one atomic
    commit: create fails if the file exists, update fails if its sha moved. That is all a maildir needs."""

    def __init__(self, spec: str = DEFAULT_STORE, token: Optional[str] = None):
        repo, _, branch = spec.partition("@")
        self.repo, self.branch = repo, branch or "agsv-store"
        self._token = token
        self._shas: dict[str, str] = {}
        self._blobs: dict[str, Any] = {}

    @property
    def token(self) -> str:
        if not self._token:
            self._token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
        if not self._token:
            self._token = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True).stdout.strip()
        return self._token

    def _req(self, method: str, path: str, body: Optional[dict] = None) -> tuple[int, Any]:
        url = f"https://api.github.com/repos/{self.repo}/{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "agsv",
            **({"Content-Type": "application/json"} if data else {}),
        })
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=30) as res:
                    raw = res.read()
                    return res.status, (json.loads(raw) if raw else None)
            except urllib.error.HTTPError as e:
                if e.code in (404, 409, 422):
                    return e.code, None
                if e.code == 401 and attempt < 3:  # the token a long-lived process holds can expire; ask gh for a fresh one
                    self._token = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True).stdout.strip()
                    req.add_header("Authorization", f"Bearer {self._token}")
                    time.sleep(1 + attempt)
                    continue
                if e.code in (500, 502, 503) and attempt < 3:
                    time.sleep(1 + attempt)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError):
                if attempt < 3:
                    time.sleep(1 + attempt)
                    continue
                raise
        raise RuntimeError("unreachable")

    def read(self, path: str) -> tuple[Optional[Any], Optional[str]]:
        status, res = self._req("GET", f"contents/{path}?ref={self.branch}&t={now_ms()}")
        if status != 200 or not isinstance(res, dict):
            return None, None
        return json.loads(base64.b64decode(res["content"]).decode()), res["sha"]

    def write(self, path: str, obj: Any, sha: Optional[str] = None) -> str:
        body = {"message": f"agsv {path}", "branch": self.branch,
                "content": base64.b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode()}
        if sha:
            body["sha"] = sha
        for attempt in range(6):
            status, res = self._req("PUT", f"contents/{path}", body)
            if status == 409 and attempt < 5:
                time.sleep(0.5 + attempt + random.random())
                continue
            if status in (409, 422) or not res:
                raise Conflict(path)
            return res["content"]["sha"]
        raise Conflict(path)

    def create(self, path: str, obj: Any) -> bool:
        try:
            self.write(path, obj)
            return True
        except Conflict:
            return False

    def delete(self, path: str, sha: str) -> None:
        self._req("DELETE", f"contents/{path}", {"message": f"agsv rm {path}", "branch": self.branch, "sha": sha})

    def ls(self, directory: str) -> list[str]:
        status, res = self._req("GET", f"contents/{directory}?ref={self.branch}&t={now_ms()}")
        return sorted(e["name"] for e in res) if status == 200 and isinstance(res, list) else []

    def snapshot(self, prefix: str) -> dict[str, Any]:
        """Every JSON file under `prefix`, in one tree call plus one blob fetch per file not seen before."""
        status, res = self._req("GET", f"git/trees/{self.branch}?recursive=1&t={now_ms()}")
        if status != 200 or not res:
            return {}
        out: dict[str, Any] = {}
        for entry in res.get("tree", []):
            path = entry["path"]
            if entry["type"] != "blob" or not path.startswith(prefix) or not path.endswith(".json"):
                continue
            sha = entry["sha"]
            if self._shas.get(path) != sha:
                st, blob = self._req("GET", f"git/blobs/{sha}")
                if st != 200 or not blob:
                    continue
                self._blobs[path] = json.loads(base64.b64decode(blob["content"]).decode())
                self._shas[path] = sha
            out[path] = self._blobs[path]
        return out

    def upsert(self, path: str, fn: Callable[[Optional[Any]], Any], tries: int = 6) -> Any:
        """Read-modify-write with retry: the heartbeat and a `progress` can race on one record."""
        for attempt in range(tries):
            current, sha = self.read(path)
            updated = fn(current)
            try:
                self.write(path, updated, sha)
                return updated
            except Conflict:
                time.sleep(0.3 * (attempt + 1) + random.random() * 0.3)
        raise Conflict(path)


class MemoryStore:
    """Same contract, in memory: tests and dry runs."""

    def __init__(self) -> None:
        self.files: dict[str, tuple[Any, str]] = {}

    def read(self, path):
        return self.files.get(path, (None, None))

    def write(self, path, obj, sha=None):
        cur = self.files.get(path)
        if (cur is None) != (sha is None) or (cur and cur[1] != sha):
            raise Conflict(path)
        new = hashlib.sha1(json.dumps(obj, sort_keys=True).encode() + os.urandom(4)).hexdigest()
        self.files[path] = (json.loads(json.dumps(obj)), new)
        return new

    def create(self, path, obj):
        try:
            self.write(path, obj)
            return True
        except Conflict:
            return False

    def delete(self, path, sha):
        self.files.pop(path, None)

    def ls(self, directory):
        d = directory.rstrip("/") + "/"
        return sorted(p[len(d):] for p in self.files if p.startswith(d) and "/" not in p[len(d):])

    def snapshot(self, prefix):
        return {p: v for p, (v, _) in self.files.items() if p.startswith(prefix)}

    def upsert(self, path, fn, tries=6):
        cur, sha = self.read(path)
        updated = fn(cur)
        self.write(path, updated, sha)
        return updated


# ---------------------------------------------------------------- identity and presence


def me_path() -> Path:
    return HOME / "me.json"


def load_me() -> dict:
    if os.environ.get("AGSV_ID"):
        return {"id": os.environ["AGSV_ID"], "name": os.environ.get("AGSV_NAME", os.environ["AGSV_ID"])}
    if not me_path().exists():
        sys.exit("agsv: not registered. Run `agsv register --name <name> --role worker|coordinator [--parent <id>]` first.")
    return json.loads(me_path().read_text())


def session_url(agent_id: str) -> Optional[str]:
    sid = agent_id[6:]
    return f"https://app.devin.ai/sessions/{sid}" if agent_id.startswith("devin-") and len(sid) == 32 else None


def agent_path(agent_id: str) -> str:
    return f"agents/{agent_id}.json"


def inbox_dir(agent_id: str) -> str:
    return f"inbox/{agent_id}"


def cursor_path(agent_id: str) -> str:
    return f"cursors/{agent_id}.json"


def is_live(agent: dict, now: int, dead_after_s: int = DEAD_AFTER_S) -> bool:
    return not agent.get("endedAt") and now - agent.get("heartbeatAt", 0) <= dead_after_s * 1000


def state_of(agent: dict, now: int, dead_after_s: int = DEAD_AFTER_S) -> str:
    if agent.get("endedAt"):
        return agent.get("status", "done")
    if not is_live(agent, now, dead_after_s):
        return "parked"
    return agent.get("status", "working")


def all_agents(store) -> dict[str, dict]:
    return {a["id"]: a for a in store.snapshot("agents/").values() if isinstance(a, dict) and "id" in a}


def resolve(store, to: str, me: dict, agents: Optional[dict] = None) -> str:
    """Strict: `parent`, or the exact id or unique name of one of your direct children. Refuse, don't guess."""
    agents = agents if agents is not None else all_agents(store)
    parent = agents.get(me["id"], {}).get("parent") or me.get("parent")
    if to == "parent" or (parent and to in (parent, agents.get(parent, {}).get("name"))):
        if not parent:
            raise SystemExit("agsv: you have no parent (register with --parent <id>).")
        return parent
    children = [a for a in agents.values() if a.get("parent") == me["id"]]
    if to in (c["id"] for c in children):
        return to
    now = now_ms()
    named = [c for c in children if c.get("name") == to]
    live = [c for c in named if is_live(c, now)]
    if len(live) == 1:
        return live[0]["id"]
    if len(live) > 1:
        raise SystemExit(f"agsv: {len(live)} live children are named {to!r}: " + ", ".join(a["id"] for a in live) + ". Use an exact id.")
    if named:
        hint = "; ".join(f"{a['id']} (last seen {ago(a.get('heartbeatAt'), now)} ago)" for a in sorted(named, key=lambda a: -a.get("heartbeatAt", 0))[:3])
        raise SystemExit(f"agsv: no live child is named {to!r}. Likely: {hint}. Use its exact id.")
    if to in agents:
        raise SystemExit(f"agsv: {to} is not your parent or child; messages go only along parent<->child. Ask your parent to relay. (Dependencies on anyone: `agsv wait-on {to} --for \"...\"`.)")
    raise SystemExit(f"agsv: {to!r} is no `parent`, child id or child name. `agsv ps` lists agents.")


def update_presence(store, agent_id: str, fn: Callable[[dict], dict]) -> dict:
    def apply(current):
        if not current:
            raise SystemExit(f"agsv: {agent_id} is not registered.")
        return fn(dict(current))
    return store.upsert(agent_path(agent_id), apply)


def register(store, agent_id: str, name: str, role: str, parent: Optional[str], note: str) -> dict:
    now = now_ms()
    record = {"v": VERSION, "id": agent_id, "name": name[:MAX_NAME], "role": role, "parent": parent,
              "url": session_url(agent_id), "host": os.uname().nodename, "status": "working", "note": clip(note or "registered"),
              "startedAt": now, "heartbeatAt": now, "progressAt": now, "waits": []}
    store.upsert(agent_path(agent_id), lambda _cur: record)
    HOME.mkdir(parents=True, exist_ok=True)
    me_path().write_text(json.dumps({"id": agent_id, "name": name, "role": role, "parent": parent}))
    return record


def heartbeat_once(store, agent_id: str) -> None:
    update_presence(store, agent_id, lambda a: {**a, "heartbeatAt": now_ms()})


def progress(store, agent_id: str, note: str) -> dict:
    now = now_ms()
    return update_presence(store, agent_id, lambda a: {**a, "status": "working" if not a.get("waits") else a.get("status"), "note": clip(note), "progressAt": now, "heartbeatAt": now})


def add_wait(store, agent_id: str, on: str, reason: str, msg_id: Optional[str] = None, until: Optional[int] = None) -> dict:
    now = now_ms()
    edge = {"on": on, "for": clip(reason), "since": now, **({"msg": msg_id} if msg_id else {}), **({"until": until} if until else {})}

    def fn(a):
        waits = [w for w in a.get("waits", []) if w["on"] != on] + [edge]
        return {**a, "status": "waiting", "waits": waits, "heartbeatAt": now, "progressAt": now}
    return update_presence(store, agent_id, fn)


def drop_wait(store, agent_id: str, on: Optional[str] = None) -> dict:
    now = now_ms()

    def fn(a):
        waits = [] if on is None else [w for w in a.get("waits", []) if w["on"] != on]
        return {**a, "status": "waiting" if waits else "working", "waits": waits, "heartbeatAt": now, "progressAt": now}
    return update_presence(store, agent_id, fn)


# ---------------------------------------------------------------- mail


def make_message(sender: dict, to: str, text: str, reply_to: Optional[str] = None, awaiting_until: Optional[int] = None,
                 kind: Optional[str] = None, about: Optional[dict] = None) -> dict:
    if not text.strip():
        raise SystemExit("agsv: message is empty")
    if len(text.encode()) > MAX_TEXT:
        raise SystemExit(f"agsv: message is {len(text.encode())} bytes (max {MAX_TEXT}); write it to a file and send the path.")
    msg = {"v": VERSION, "id": new_id(), "ts": now_ms(), "from": {"id": sender["id"], "name": sender.get("name", sender["id"])}, "to": to, "text": text}
    for key, value in (("replyTo", reply_to), ("awaitingUntil", awaiting_until), ("kind", kind), ("about", about)):
        if value:
            msg[key] = value
    return msg


def post(store, msg: dict) -> dict:
    if not store.create(f"{inbox_dir(msg['to'])}/{msg['id']}.json", msg):
        raise RuntimeError(f"message id collided: {msg['id']}")
    return msg


ICON = {"says": "💬", "done": "✅", "failed": "❌", "deadlock": "🔒", "died": "💀", "stalled": "⏳", "blocked": "🚫", "ended": "✅"}


def chat_note(who: str, verb: str, text: str, hint: str = "`agsv recv` for the full message") -> str:
    """Markdown for a Devin chat: one bold line saying who and what, the body quoted, a small hint."""
    body = text.strip()
    quoted = "\n```\n" + body[:6000] + "\n```" if "\n" in body else f" {clip(body, 400)}"
    return f"{ICON.get(verb, '📨')} **{who}** · {verb}:{quoted}\n_{hint}_"


def devin_wake(agent_id: str, text: str) -> bool:
    """With DEVIN_API_KEY, a message to the Devin session itself: a sleeping session wakes for it."""
    key, org = os.environ.get("AGSV_DEVIN_TOKEN") or os.environ.get("DEVIN_API_KEY"), os.environ.get("DEVIN_ORG_ID")
    if not key or not agent_id.startswith("devin-"):
        return False
    url = (f"https://api.devin.ai/v3/organizations/{org}/sessions/{agent_id}/messages" if org  # PAT / service user
           else f"https://api.devin.ai/v1/session/{agent_id}/message")  # legacy API key
    req = urllib.request.Request(url, data=json.dumps({"message": text}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "agsv"})
    try:
        with urllib.request.urlopen(req, timeout=20):
            return True
    except Exception:
        return False


def read_cursor(store, agent_id: str) -> tuple[dict, Optional[str]]:
    cur, sha = store.read(cursor_path(agent_id))
    return (cur or {"after": 0, "taken": []}), sha


def ts_of(msg_id: str) -> int:
    try:
        return int(msg_id.split("-")[0], 36)
    except ValueError:
        return 0


SKEW_MS = 120_000


def new_mail(store, agent_id: str, cursor: dict) -> list[dict]:
    """Messages after the cursor, oldest first, minus the ones a waiting send already took.
    The cursor is a time plus the ids seen since; it tolerates clocks up to SKEW_MS apart."""
    taken = set(cursor.get("taken", []))
    out = []
    for name in store.ls(inbox_dir(agent_id)):
        mid = name[:-5]
        if ts_of(mid) < cursor.get("after", 0) or mid in taken:
            continue
        msg, _ = store.read(f"{inbox_dir(agent_id)}/{name}")
        if msg:
            out.append(msg)
    return sorted(out, key=lambda m: (m.get("ts", 0), m["id"]))


def advance(store, agent_id: str, cursor: dict, sha: Optional[str], delivered: Iterable[dict], took: Iterable[str] = ()) -> None:
    """The cursor moves after delivery: a crash between read and advance redelivers, never loses."""
    ids = set(cursor.get("taken", [])) | {m["id"] for m in delivered} | set(took)
    newest = max([cursor.get("after", 0)] + [ts_of(i) for i in ids])
    after = max(0, newest - SKEW_MS)
    store.write(cursor_path(agent_id), {"after": after, "taken": sorted(i for i in ids if ts_of(i) >= after)}, sha)


def frame(msg: dict, me_id: str, now: int) -> str:
    """What the receiving agent reads: the message, then one line saying who it is from and what to do."""
    sender = msg["from"]
    attrs = f'id="{msg["id"]}" from="{sender.get("name", sender["id"])}" session="{sender["id"]}"'
    for key in ("kind", "replyTo"):
        if msg.get(key):
            attrs += f' {key}="{msg[key]}"'
    body = f"<msg {attrs}>\n{msg['text']}\n</msg>"
    kind = msg.get("kind")
    who = sender.get("name", sender["id"])
    if kind in ("deadlock", "died", "stalled", "blocked"):
        return body + f"\nFrom the agsv supervisor (a runtime, not your user): a {kind} notice. It is reported once; act on it or leave it."
    if kind == "ended":
        return body + f"\n{who} ended; above is its final report. It can't answer anymore." + (f" Its session: {session_url(sender['id'])}" if session_url(sender["id"]) else "")
    if msg.get("awaitingUntil"):
        left = ago(2 * now - msg["awaitingUntil"], now) if msg["awaitingUntil"] > now else "no time"
        return body + f"\nFrom {who} (another agent, not your user). {who} is blocked waiting for your reply ({left} left): answer with `agsv send {sender['id']} --reply-to {msg['id']} \"...\"`."
    return body + f"\nFrom {who} (another agent, not your user). Reply, if one is needed, with `agsv send {sender['id']} --reply-to {msg['id']} \"...\"`."


def send(store, me: dict, to: str, text: str, reply_to: Optional[str] = None, wait_s: int = 0, poll_s: float = POLL_S) -> Optional[dict]:
    """Deliver, and with `wait_s` block for the answer: that is a wait-for edge on the recipient while it lasts.
    A reply to this message, or the recipient's `ended`, comes back as the result and never enters the inbox."""
    agents = all_agents(store)
    deadline = now_ms() + wait_s * 1000
    while True:
        try:
            target = resolve(store, to, me, agents)
            break
        except SystemExit as e:
            if wait_s and "no live child is named" in str(e) and now_ms() < deadline:
                print(f"agsv: nobody live is named {to!r} yet; waiting for it to register…", file=sys.stderr)
                time.sleep(poll_s * 2)
                agents = all_agents(store)
                continue
            raise
    msg = post(store, make_message(me, target, text, reply_to, deadline if wait_s else None))
    name = agents.get(target, {}).get("name", target)
    devin_wake(target, chat_note(me.get("name", me["id"]), "says", text, "waiting for your reply: `agsv send parent \"...\"`" if wait_s else "`agsv recv` for the full message"))
    if not wait_s:
        print(f"sent {msg['id']} to {name} ({target})")
        return None
    add_wait(store, me["id"], target, text, msg["id"], deadline)
    try:
        last_beat = 0
        while now_ms() < deadline:
            if now_ms() - last_beat > HEARTBEAT_S * 1000:
                heartbeat_once(store, me["id"])
                last_beat = now_ms()
            cursor, sha = read_cursor(store, me["id"])
            for candidate in new_mail(store, me["id"], cursor):
                answers = candidate.get("replyTo") == msg["id"]
                exit_notice = candidate.get("kind") in ("ended", "died") and (candidate.get("about") or {}).get("id", candidate["from"]["id"]) == target
                deadlock = candidate.get("kind") == "deadlock"
                if answers or exit_notice or deadlock:
                    advance(store, me["id"], cursor, sha, [], [candidate["id"]])
                    print(frame(candidate, me["id"], now_ms()))
                    return candidate
            time.sleep(poll_s)
        print(f"no reply from {name} within {wait_s}s (message {msg['id']} is still in its inbox).")
        return None
    finally:
        drop_wait(store, me["id"], target)


def recv(store, me: dict, wait_s: int = 0, poll_s: float = POLL_S) -> list[dict]:
    deadline = now_ms() + wait_s * 1000
    last_beat = 0
    while True:
        cursor, sha = read_cursor(store, me["id"])
        mail = new_mail(store, me["id"], cursor)
        if mail or now_ms() >= deadline:
            break
        if now_ms() - last_beat > HEARTBEAT_S * 1000:
            heartbeat_once(store, me["id"])
            last_beat = now_ms()
        time.sleep(poll_s)
    if not mail:
        print("no new mail.")
        return []
    now = now_ms()
    print("\n\n".join(frame(m, me["id"], now) for m in mail))
    advance(store, me["id"], cursor, sha, mail)
    return mail


def done(store, me: dict, report: str, failed: bool = False, result: Optional[dict] = None) -> None:
    """Final report to the parent and to whoever waits on us. `result` is a typed payload the parent reads as JSON."""
    now = now_ms()
    agents = all_agents(store)
    record = update_presence(store, me["id"], lambda a: {**a, "status": "failed" if failed else "done", "note": clip(report), "waits": [], "endedAt": now,
                                                        "heartbeatAt": now, "progressAt": now, **({"result": result} if result is not None else {})})
    text = report.strip() or "(it ended without a report)"
    if result is not None:
        text += "\n" + json.dumps(result, indent=1)
    recipients = {record.get("parent")} | {a["id"] for a in agents.values() if any(w["on"] == me["id"] for w in a.get("waits", []))}
    for to in filter(None, recipients):
        post(store, make_message(me, to, text, kind="ended", about={"id": me["id"], "failed": failed, **({"result": result} if result is not None else {})}))
        devin_wake(to, chat_note(me.get("name", me["id"]), "failed" if failed else "done", report, "`agsv recv` for the full report"))
    stop_heartbeat()
    print(f"ended; report sent to {', '.join(sorted(filter(None, recipients))) or 'nobody'}.")


# ---------------------------------------------------------------- heartbeat daemon


def pid_path() -> Path:
    return HOME / "heartbeat.pid"


def heartbeat_running() -> Optional[int]:
    try:
        pid = int(pid_path().read_text())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def start_heartbeat() -> int:
    if (pid := heartbeat_running()):
        return pid
    HOME.mkdir(parents=True, exist_ok=True)
    log = open(HOME / "heartbeat.log", "ab")
    proc = subprocess.Popen([sys.executable, os.path.abspath(__file__), "_heartbeat"], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    pid_path().write_text(str(proc.pid))
    return proc.pid


def stop_heartbeat() -> None:
    if (pid := heartbeat_running()):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    pid_path().unlink(missing_ok=True)


def heartbeat_loop(store, me: dict) -> None:
    while True:
        try:
            heartbeat_once(store, me["id"])
        except SystemExit:
            return
        except Exception as e:
            print(f"{utc(now_ms())} heartbeat failed: {e}", flush=True)
        time.sleep(HEARTBEAT_S)


# ---------------------------------------------------------------- wait-for graph


def wait_edges(agents: dict[str, dict], now: int) -> list[dict]:
    """Live edges: an agent that has ended waits on nobody, and an expired wait is over."""
    out = []
    for a in agents.values():
        if a.get("endedAt"):
            continue
        for w in a.get("waits", []):
            if w.get("until") and w["until"] < now:
                continue
            out.append({"src": a["id"], **w})
    return out


def cycles(edges: list[dict]) -> list[list[dict]]:
    """Tarjan: every strongly connected component with a cycle, as its edges in walk order."""
    adj: dict[str, list[dict]] = {}
    for e in edges:
        adj.setdefault(e["src"], []).append(e)
        adj.setdefault(e["on"], [])
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    comps: list[set[str]] = []
    counter = [0]

    def visit(v: str) -> None:
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on_stack.add(v)
        for e in adj[v]:
            w = e["on"]
            if w not in index:
                visit(w)
                low[v] = min(low[v], low[w])
            elif w in on_stack:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = set()
            while True:
                w = stack.pop()
                on_stack.discard(w)
                comp.add(w)
                if w == v:
                    break
            comps.append(comp)

    for v in sorted(adj):
        if v not in index:
            visit(v)

    found = []
    for comp in comps:
        inside = [e for e in edges if e["src"] in comp and e["on"] in comp]
        if not inside:
            continue
        start = min(comp)
        walk, seen, cur = [], set(), start
        while cur not in seen:
            seen.add(cur)
            nxt = next((e for e in inside if e["src"] == cur), None)
            if not nxt:
                break
            walk.append(nxt)
            cur = nxt["on"]
        found.append(walk)
    return found


def label(agents: dict, agent_id: str) -> str:
    a = agents.get(agent_id)
    return f"{a['name']} ({agent_id})" if a else agent_id


def deadlock_text(agents: dict, cycle: list[dict], now: int) -> str:
    lines = [f"deadlock: {len(cycle)} agents wait on each other in a cycle and none can move:"]
    for e in cycle:
        lines.append(f"  {label(agents, e['src'])} -> waits on {label(agents, e['on'])} for {ago(e['since'], now)}: {e['for']}")
    lines.append("Every one of them is alive and healthy; the cycle is why nothing happens.")
    lines.append("Break it: pick one edge and resolve it from outside (give the approval yourself, drop the dependency, "
                 "reorder the work, or stop one agent). To stop one: `agsv send <id> \"stop: ...\"` then check it in Devin.")
    return "\n".join(lines)


def died_text(agents: dict, a: dict, now: int) -> str:
    waiters = [x for x in agents.values() if any(w["on"] == a["id"] for w in x.get("waits", [])) and not x.get("endedAt")]
    text = (f"{a['name']} ({a['id']}) went quiet: no heartbeat for {ago(a.get('heartbeatAt'), now)} (last note: {a.get('note', '')!r}). "
            f"Its session likely died or its VM slept.")
    if a.get("url"):
        text += f" Check {a['url']}."
    if waiters:
        text += " Waiting on it: " + ", ".join(label(agents, w["id"]) for w in waiters) + "."
    return text


def stalled_text(a: dict, now: int) -> str:
    return (f"{a['name']} ({a['id']}) is alive but has made no progress for {ago(a.get('progressAt'), now)} "
            f"(status {a.get('status')}, last note: {a.get('note', '')!r}). Probably looping or stuck in a long command." + (f" Check {a['url']}." if a.get("url") else ""))


def blocked_on_dead_text(agents: dict, a: dict, edge: dict, now: int, dead_after_s: int = DEAD_AFTER_S) -> str:
    target = agents.get(edge["on"], {"name": edge["on"], "id": edge["on"]})
    state = state_of(target, now, dead_after_s) if target.get("heartbeatAt") else "unknown here"
    return (f"{a['name']} ({a['id']}) has waited {ago(edge['since'], now)} on {target['name']} ({target['id']}) for {edge['for']!r}, "
            f"but {target['name']} is {state} and will never answer. Unblock {a['name']}: `agsv send {a['id']} \"...\"`.")


def incidents(agents: dict, now: int, dead_after_s: int = DEAD_AFTER_S, stall_after_s: int = STALL_AFTER_S) -> list[dict]:
    """Pure: what is wrong right now. `key` is stable per incident, so each is reported once."""
    out = []
    for a in agents.values():
        if a.get("endedAt"):
            continue
        if not is_live(a, now, dead_after_s):
            out.append({"key": f"died:{a['id']}:{a.get('heartbeatAt')}", "kind": "died", "about": a["id"], "text": died_text(agents, a, now)})
        elif a.get("status") == "working" and a.get("role") != "coordinator" and now - a.get("progressAt", now) > stall_after_s * 1000:
            out.append({"key": f"stalled:{a['id']}:{a.get('progressAt')}", "kind": "stalled", "about": a["id"], "text": stalled_text(a, now)})
    edges = wait_edges(agents, now)
    for e in edges:
        target = agents.get(e["on"])
        if target is None or not is_live(target, now, dead_after_s):
            out.append({"key": f"blocked:{e['src']}:{e['on']}:{e['since']}", "kind": "blocked", "about": e["src"],
                        "text": blocked_on_dead_text(agents, agents[e["src"]], e, now, dead_after_s)})
    for cyc in cycles(edges):
        key = "deadlock:" + ",".join(f"{e['src']}>{e['on']}@{e['since']}" for e in cyc)
        out.append({"key": key, "kind": "deadlock", "about": [e["src"] for e in cyc], "cycle": cyc, "text": deadlock_text(agents, cyc, now)})
    return out


def supervise_once(store, coordinator: str, seen: set[str], now: Optional[int] = None, dead_after_s: int = DEAD_AFTER_S,
                   stall_after_s: int = STALL_AFTER_S) -> list[dict]:
    """One tick. New incidents become messages: to the coordinator, and a deadlock also to everyone in the cycle."""
    now = now or now_ms()
    agents = all_agents(store)
    fresh = []
    for inc in incidents(agents, now, dead_after_s, stall_after_s):
        if inc["key"] in seen:
            continue
        recipients = {coordinator} | (set(inc["about"]) if inc["kind"] == "deadlock" else set())
        for to in recipients:
            post(store, make_message(SUPERVISOR, to, inc["text"], kind=inc["kind"], about={"id": inc["about"], "key": inc["key"]}))
            devin_wake(to, chat_note("supervisor", inc["kind"], inc["text"], "from the agsv runtime, not your user; reported once"))
        seen.add(inc["key"])
        store.create(f"incidents/{hashlib.sha1(inc['key'].encode()).hexdigest()[:16]}.json", {**inc, "at": now, "sentTo": sorted(recipients)})
        fresh.append(inc)
    return fresh


def relay_to_chat(coordinator: str, m: dict) -> None:
    """Children hold no Devin credentials; the supervisor posts their mail into the parent's session for them."""
    who, kind = m.get("from", {}).get("name", "?"), m.get("kind")
    verb = {"ended": "done" if not (m.get("about") or {}).get("failed") else "failed"}.get(kind, "says")
    if devin_wake(coordinator, chat_note(who, verb, m.get("text", ""))):
        print(f"{utc(now_ms())} relayed {kind or 'message'} from {who} to the coordinator's chat", flush=True)


def supervise(store, coordinator: str, interval_s: float = 10, dead_after_s: int = DEAD_AFTER_S, stall_after_s: int = STALL_AFTER_S) -> None:
    seen = {i.get("key") for i in store.snapshot("incidents/").values() if isinstance(i, dict)}
    relayed = set(store.snapshot(inbox_dir(coordinator) + "/"))
    print(f"{utc(now_ms())} supervising for {coordinator}; {len(seen)} past incidents on record", flush=True)
    while True:
        try:
            for inc in supervise_once(store, coordinator, seen, None, dead_after_s, stall_after_s):
                print(f"{utc(now_ms())} {inc['kind']}: {inc['text'].splitlines()[0]}", flush=True)
            for path, m in sorted(store.snapshot(inbox_dir(coordinator) + "/").items()):
                if path in relayed or not isinstance(m, dict):
                    continue
                relayed.add(path)
                if m.get("from", {}).get("id") != SUPERVISOR["id"]:
                    relay_to_chat(coordinator, m)
        except Exception as e:
            print(f"{utc(now_ms())} tick failed: {e}", flush=True)
        time.sleep(interval_s)


# ---------------------------------------------------------------- views


def ps_text(agents: dict, now: int) -> str:
    if not agents:
        return "no agents."
    rows = []
    for a in sorted(agents.values(), key=lambda a: (a.get("parent") or "", a.get("startedAt", 0))):
        waits = ", ".join(f"-> {agents.get(w['on'], {}).get('name', w['on'])}: {w['for']}" for w in a.get("waits", []))
        rows.append((a["name"], a["id"], state_of(a, now), ago(a.get("heartbeatAt"), now), ago(a.get("progressAt"), now), clip(a.get("note", ""), 60) + (f"  [{waits}]" if waits else "")))
    widths = [max(len(r[i]) for r in rows + [("NAME", "ID", "STATE", "BEAT", "PROGRESS", "NOTE")]) for i in range(5)]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths) + "  {}"
    return "\n".join([fmt.format("NAME", "ID", "STATE", "BEAT", "PROGRESS", "NOTE")] + [fmt.format(*r) for r in rows])


def graph_text(agents: dict, now: int) -> str:
    edges = wait_edges(agents, now)
    cycs = cycles(edges)
    in_cycle = {e["src"] for c in cycs for e in c}
    lines = ["wait-for graph"]
    for a in sorted(agents.values(), key=lambda a: a["name"]):
        mark = " !! in a cycle" if a["id"] in in_cycle else ""
        lines.append(f"  {a['name']} [{state_of(a, now)}]{mark}")
        for e in (e for e in edges if e["src"] == a["id"]):
            lines.append(f"      -> {agents.get(e['on'], {}).get('name', e['on'])}  ({ago(e['since'], now)}) {e['for']}")
    if cycs:
        lines.append("")
        for c in cycs:
            lines.append("DEADLOCK: " + " -> ".join(agents.get(e["src"], {}).get("name", e["src"]) for e in c) + f" -> {agents.get(c[0]['src'], {}).get('name', c[0]['src'])}")
    else:
        lines.append("  no cycles.")
    return "\n".join(lines)


def graph_json(agents: dict, now: int) -> dict:
    edges = wait_edges(agents, now)
    cycs = cycles(edges)
    return {"now": now, "agents": [{**a, "state": state_of(a, now)} for a in agents.values()], "edges": edges,
            "cycles": [[{"src": e["src"], "on": e["on"]} for e in c] for c in cycs], "incidents": []}


DASHBOARD = """<!doctype html><meta charset=utf-8><title>agsv</title>
<style>body{font:14px/1.4 ui-monospace,monospace;margin:0;background:#0b0e14;color:#d7dae0;display:grid;grid-template-columns:1fr 380px;height:100vh}
svg{width:100%;height:100%}aside{overflow:auto;padding:14px;border-left:1px solid #222;background:#0e121a}
h1{font-size:14px;margin:0 0 10px}.row{padding:6px 0;border-bottom:1px solid #1b2130}.id{color:#6b7280;font-size:11px}
.working{color:#4ade80}.waiting{color:#facc15}.parked,.failed{color:#f87171}.done{color:#6b7280}
.alert{background:#3b0d0d;border:1px solid #b91c1c;padding:8px;margin:10px 0;white-space:pre-wrap;font-size:12px}
text{fill:#d7dae0;font-size:12px}.e{stroke:#4b5563;stroke-width:1.5;fill:none;marker-end:url(#a)}.e.cyc{stroke:#ef4444;stroke-width:2.5;marker-end:url(#ar)}
.el{fill:#9ca3af;font-size:10px}</style>
<svg id=g><defs><marker id=a viewBox="0 0 10 10" refX=10 refY=5 markerWidth=8 markerHeight=8 orient=auto><path d="M0 0L10 5L0 10z" fill="#4b5563"/></marker>
<marker id=ar viewBox="0 0 10 10" refX=10 refY=5 markerWidth=8 markerHeight=8 orient=auto><path d="M0 0L10 5L0 10z" fill="#ef4444"/></marker></defs></svg>
<aside><h1>agsv &middot; <span id=t></span></h1><div id=alerts></div><div id=list></div></aside>
<script>
const color={working:'#4ade80',waiting:'#facc15',parked:'#f87171',failed:'#f87171',done:'#6b7280'};
const ago=(ts,now)=>{const s=Math.max(0,(now-ts)/1000|0);return s<60?s+'s':s<3600?(s/60|0)+'m':(s/3600|0)+'h'};
async function tick(){const d=await (await fetch('/graph.json')).json();const now=d.now;
const svg=document.getElementById('g'),W=svg.clientWidth,H=svg.clientHeight,R=Math.min(W,H)/2-110,cx=W/2,cy=H/2;
const A=d.agents,pos={};A.forEach((a,i)=>{const t=2*Math.PI*i/A.length-Math.PI/2;pos[a.id]=[cx+R*Math.cos(t),cy+R*Math.sin(t)]});
const cyc=new Set(d.cycles.flat().map(e=>e.src+'>'+e.on));
let s='';for(const e of d.edges){const [x1,y1]=pos[e.src]||[cx,cy],[x2,y2]=pos[e.on]||[cx,cy];const dx=x2-x1,dy=y2-y1,L=Math.hypot(dx,dy)||1,ux=dx/L,uy=dy/L;
const sx=x1+ux*34,sy=y1+uy*34,ex=x2-ux*38,ey=y2-uy*38,mx=(sx+ex)/2-uy*18,my=(sy+ey)/2+ux*18;
s+=`<path class="e ${cyc.has(e.src+'>'+e.on)?'cyc':''}" d="M${sx} ${sy}Q${mx} ${my} ${ex} ${ey}"/><text class=el x=${mx} y=${my-4} text-anchor=middle>${e.for.slice(0,40)} (${ago(e.since,now)})</text>`}
for(const a of A){const [x,y]=pos[a.id];s+=`<circle cx=${x} cy=${y} r=30 fill="#111827" stroke="${color[a.state]||'#999'}" stroke-width=3/><text x=${x} y=${y+4} text-anchor=middle>${a.name}</text><text class=el x=${x} y=${y+48} text-anchor=middle>${a.state} · beat ${ago(a.heartbeatAt,now)}</text>`}
svg.innerHTML=svg.querySelector('defs').outerHTML+s;
document.getElementById('t').textContent=new Date(now).toISOString().slice(11,19)+'Z';
document.getElementById('alerts').innerHTML=d.cycles.map(c=>`<div class=alert>DEADLOCK\\n${c.map(e=>name(e.src)).join(' → ')} → ${name(c[0].src)}</div>`).join('')+d.incidents.map(i=>`<div class=alert>${i.kind}\\n${i.text}</div>`).join('');
function name(id){return (A.find(a=>a.id===id)||{name:id}).name}
document.getElementById('list').innerHTML=A.map(a=>`<div class=row><b class=${a.state}>${a.name}</b> ${a.state} <span class=id>${a.id}</span><br>${a.note||''}${(a.waits||[]).map(w=>`<br>→ waits on <b>${name(w.on)}</b> for ${ago(w.since,now)}: ${w.for}`).join('')}</div>`).join('')}
tick();setInterval(tick,4000);
</script>"""


def serve(store, port: int) -> None:
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path.startswith("/graph.json"):
                now = now_ms()
                data = graph_json(all_agents(store), now)
                data["incidents"] = sorted((i for i in store.snapshot("incidents/").values() if isinstance(i, dict)), key=lambda i: -i.get("at", 0))[:5]
                body, ctype = json.dumps(data).encode(), "application/json"
            else:
                body, ctype = DASHBOARD.encode(), "text/html; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    print(f"dashboard on http://localhost:{port}", flush=True)
    HTTPServer(("0.0.0.0", port), H).serve_forever()


# ---------------------------------------------------------------- CLI


GUIDE = """You are one agent in an agsv-supervised fleet. agsv is a CLI (python3, already here):
  agsv recv [--wait N]                 read new mail (block up to N seconds for it); frames say who wrote and what to do
  agsv send parent "..." [--wait N]    message your parent; with --wait you block for the reply (the runtime records that you wait)
  agsv send <child> "..." [--reply-to <id>]   (parents) message a child by name or id; --reply-to answers a waiting question
  agsv wait-on <agent> --for "..."     declare you can't continue until that agent delivers; `agsv wait-on --clear` when you can
  agsv progress "..."                  one line on what you're doing now (do this every few steps; silence for 10 min reads as stalled)
  agsv done "..." [--json '{...}']    your final report (and an optional typed result), sent to your parent. Always end with done or failed.
  agsv ps / agsv graph                 who is here, who waits on whom
Messages go only parent<->child. Deaths, stalls and deadlocks reach your parent as messages from `supervisor`."""


def main(argv: Optional[list[str]] = None) -> None:
    p = argparse.ArgumentParser(prog="agsv", description="process supervision for Devin agents")
    p.add_argument("--store", default=os.environ.get("AGSV_STORE", DEFAULT_STORE), help="owner/repo@branch (default %(default)s)")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("register", help="join the fleet as this session")
    r.add_argument("--name", required=True)
    r.add_argument("--role", default="worker", choices=["worker", "coordinator"])
    r.add_argument("--parent")
    r.add_argument("--id", help="agent id (default: devin-<session id> from DEVIN_SESSION_ID, else host-based)")
    r.add_argument("--note", default="")
    r.add_argument("--no-heartbeat", action="store_true")
    s = sub.add_parser("send", help="message your parent or a child")
    s.add_argument("to")
    s.add_argument("text")
    s.add_argument("--reply-to")
    s.add_argument("--wait", type=int, default=0, help="seconds to block for a reply")
    rv = sub.add_parser("recv", help="read new mail")
    rv.add_argument("--wait", type=int, default=0)
    w = sub.add_parser("wait-on", help="declare a dependency on another agent")
    w.add_argument("agent", nargs="?")
    w.add_argument("--for", dest="reason", default="")
    w.add_argument("--clear", action="store_true", help="drop the dependency (all of them without an agent)")
    pr = sub.add_parser("progress", help="note what you are doing")
    pr.add_argument("text")
    d = sub.add_parser("done", help="final report to your parent")
    d.add_argument("text", nargs="?", default="")
    d.add_argument("--json", dest="result", help="a typed result for the parent (JSON object)")
    f = sub.add_parser("failed", help="final report, failed")
    f.add_argument("text", nargs="?", default="")
    f.add_argument("--json", dest="result")
    rs = sub.add_parser("reset", help="wipe the store (agents, mail, cursors, incidents)")
    rs.add_argument("--yes", action="store_true")
    sub.add_parser("ps", help="list agents")
    g = sub.add_parser("graph", help="the wait-for graph")
    g.add_argument("--json", action="store_true")
    sv = sub.add_parser("supervise", help="the runtime: died/stalled/blocked/deadlock -> messages")
    sv.add_argument("--coordinator", help="who gets the notices (default: me)")
    sv.add_argument("--interval", type=float, default=10)
    sv.add_argument("--dead-after", type=int, default=DEAD_AFTER_S)
    sv.add_argument("--stall-after", type=int, default=STALL_AFTER_S)
    sv.add_argument("--once", action="store_true")
    wb = sub.add_parser("web", help="live dashboard")
    wb.add_argument("--port", type=int, default=8787)
    sub.add_parser("guide", help="print the paragraph to paste into a child's prompt")
    sub.add_parser("whoami")
    sub.add_parser("_heartbeat")
    a = p.parse_args(argv)

    store = GitHubStore(a.store)
    if a.cmd == "guide":
        print(GUIDE)
        return
    if a.cmd == "register":
        agent_id = a.id or (f"devin-{os.environ['DEVIN_SESSION_ID']}" if os.environ.get("DEVIN_SESSION_ID") else f"{os.uname().nodename}-{b36(os.getpid())}")
        rec = register(store, agent_id, a.name, a.role, a.parent, a.note)
        if not a.no_heartbeat:
            start_heartbeat()
        print(f"registered {rec['name']} as {rec['id']}" + (f" (parent {rec['parent']})" if rec["parent"] else "") + ("." if a.no_heartbeat else "; heartbeat running."))
        return
    if a.cmd in ("ps", "graph"):
        agents, now = all_agents(store), now_ms()
        print(json.dumps(graph_json(agents, now), indent=1) if a.cmd == "graph" and a.json else (ps_text if a.cmd == "ps" else graph_text)(agents, now))
        return
    if a.cmd == "web":
        serve(store, a.port)
        return
    if a.cmd == "reset":
        if not a.yes:
            raise SystemExit("agsv: reset wipes every agent, message and incident in the store. Add --yes.")
        print(f"removed {reset(store)} files.")
        return
    me = load_me()
    if a.cmd == "whoami":
        print(json.dumps(me))
    elif a.cmd == "_heartbeat":
        heartbeat_loop(store, me)
    elif a.cmd == "send":
        send(store, me, a.to, a.text, a.reply_to, a.wait)
    elif a.cmd == "recv":
        recv(store, me, a.wait)
    elif a.cmd == "wait-on":
        if a.clear:
            drop_wait(store, me["id"], a.agent and resolve_any(store, a.agent))
            print("cleared.")
        else:
            if not a.agent or not a.reason:
                raise SystemExit("agsv: wait-on <agent> --for \"what you need from it\"")
            target = resolve_any(store, a.agent)
            add_wait(store, me["id"], target, a.reason)
            print(f"waiting on {target} for {a.reason!r}; `agsv wait-on {a.agent} --clear` when you have it.")
    elif a.cmd == "progress":
        progress(store, me["id"], a.text)
        print("noted.")
    elif a.cmd in ("done", "failed"):
        done(store, me, a.text, failed=a.cmd == "failed", result=json.loads(a.result) if a.result else None)
    elif a.cmd == "supervise":
        if a.once:
            seen = {i.get("key") for i in store.snapshot("incidents/").values() if isinstance(i, dict)}
            for inc in supervise_once(store, a.coordinator or me["id"], seen, None, a.dead_after, a.stall_after):
                print(f"{inc['kind']}: {inc['text']}")
        else:
            supervise(store, a.coordinator or me["id"], a.interval, a.dead_after, a.stall_after)


def reset(store) -> int:
    n = 0
    for path in list(store.snapshot("")):
        _, sha = store.read(path)
        if sha:
            store.delete(path, sha)
            n += 1
    return n


def resolve_any(store, to: str) -> str:
    """For wait-on: a dependency can be on anyone. Exact id, or the unique name of a live agent."""
    agents = all_agents(store)
    if to in agents:
        return to
    now = now_ms()
    live = [a for a in agents.values() if a.get("name") == to and is_live(a, now)]
    if len(live) == 1:
        return live[0]["id"]
    raise SystemExit(f"agsv: {to!r} is not an exact id or the name of exactly one live agent ({len(live)} match). `agsv ps` lists them.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
