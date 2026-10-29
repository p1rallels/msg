"""python3 devin/test_agsv.py — unit tests on the in-memory store; never touches GitHub."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ["AGSV_HOME"] = tempfile.mkdtemp()
import agsv  # noqa: E402

S = 1000


def fleet(store, names, parent="devin-root", t=0):
    agsv.register(store, parent, "root", "coordinator", None, "")
    out = {}
    for n in names:
        out[n] = agsv.register(store, f"devin-{n}", n, "worker", parent, "")
    return out


class Cycles(unittest.TestCase):
    def test_three_cycle_found_exactly(self):
        edges = [{"src": "a", "on": "b", "for": "interface", "since": 1}, {"src": "b", "on": "c", "for": "migration", "since": 2},
                 {"src": "c", "on": "a", "for": "approval", "since": 3}, {"src": "d", "on": "a", "for": "unrelated", "since": 4}]
        cycs = agsv.cycles(edges)
        self.assertEqual(len(cycs), 1)
        self.assertEqual([(e["src"], e["on"]) for e in cycs[0]], [("a", "b"), ("b", "c"), ("c", "a")])

    def test_chain_is_not_a_cycle(self):
        self.assertEqual(agsv.cycles([{"src": "a", "on": "b", "for": "", "since": 1}, {"src": "b", "on": "c", "for": "", "since": 1}]), [])

    def test_two_cycles(self):
        edges = [{"src": "a", "on": "b", "for": "", "since": 1}, {"src": "b", "on": "a", "for": "", "since": 1},
                 {"src": "x", "on": "y", "for": "", "since": 1}, {"src": "y", "on": "x", "for": "", "since": 1}]
        self.assertEqual(len(agsv.cycles(edges)), 2)

    def test_self_wait_is_a_cycle(self):
        self.assertEqual(len(agsv.cycles([{"src": "a", "on": "a", "for": "", "since": 1}])), 1)


class Supervisor(unittest.TestCase):
    def setUp(self):
        self.store = agsv.MemoryStore()
        self.now = agsv.now_ms()
        fleet(self.store, ["a", "b", "c"])

    def notices(self, who):
        return [m for m in self.store.snapshot(f"inbox/{who}/").values()]

    def test_deadlock_reported_once_to_coordinator_and_members(self):
        agsv.add_wait(self.store, "devin-a", "devin-b", "interface")
        agsv.add_wait(self.store, "devin-b", "devin-c", "migration")
        agsv.add_wait(self.store, "devin-c", "devin-a", "approval")
        seen = set()
        fresh = agsv.supervise_once(self.store, "devin-root", seen, self.now)
        self.assertEqual([i["kind"] for i in fresh], ["deadlock"])
        self.assertIn("a (devin-a) -> waits on b (devin-b)", fresh[0]["text"])
        self.assertIn("approval", fresh[0]["text"])
        self.assertEqual(len(self.notices("devin-root")), 1)
        self.assertEqual(len(self.notices("devin-a")), 1)
        self.assertEqual(agsv.supervise_once(self.store, "devin-root", seen, self.now + 60 * S), [])
        self.assertEqual(len(self.notices("devin-root")), 1)
        # breaking one edge ends the incident; a new cycle later is a new incident
        agsv.drop_wait(self.store, "devin-c", "devin-a")
        self.assertEqual(agsv.supervise_once(self.store, "devin-root", seen, self.now + 61 * S), [])

    def test_restart_does_not_rereport(self):
        agsv.add_wait(self.store, "devin-a", "devin-b", "x")
        agsv.add_wait(self.store, "devin-b", "devin-a", "y")
        agsv.supervise_once(self.store, "devin-root", set(), self.now)
        seen = {i["key"] for i in self.store.snapshot("incidents/").values()}
        self.assertEqual(agsv.supervise_once(self.store, "devin-root", seen, self.now), [])

    def test_died_then_blocked_on_dead(self):
        agsv.add_wait(self.store, "devin-a", "devin-b", "interface")
        later = self.now + (agsv.DEAD_AFTER_S + 5) * S
        for n in ("a", "root"):
            agsv.update_presence(self.store, f"devin-{n}", lambda x: {**x, "heartbeatAt": later, "progressAt": later})
        fresh = agsv.supervise_once(self.store, "devin-root", set(), later)
        kinds = sorted(i["kind"] for i in fresh)
        self.assertEqual(kinds, ["blocked", "died", "died"])  # b and c quiet; a blocked on dead b
        blocked = next(i for i in fresh if i["kind"] == "blocked")
        self.assertIn("will never answer", blocked["text"])

    def test_stalled(self):
        later = self.now + (agsv.STALL_AFTER_S + 5) * S
        for n in "abc":
            agsv.update_presence(self.store, f"devin-{n}", lambda x: {**x, "heartbeatAt": later})
        agsv.update_presence(self.store, "devin-root", lambda x: {**x, "heartbeatAt": later, "progressAt": later})
        agsv.progress(self.store, "devin-a", "still going")
        agsv.update_presence(self.store, "devin-a", lambda x: {**x, "progressAt": later, "heartbeatAt": later})
        fresh = agsv.supervise_once(self.store, "devin-root", set(), later)
        self.assertEqual(sorted(i["about"] for i in fresh if i["kind"] == "stalled"), ["devin-b", "devin-c"])

    def test_ended_agent_has_no_edges(self):
        agsv.add_wait(self.store, "devin-a", "devin-b", "x")
        agsv.add_wait(self.store, "devin-b", "devin-a", "y")
        agsv.update_presence(self.store, "devin-b", lambda x: {**x, "endedAt": self.now, "waits": []})
        self.assertEqual([i["kind"] for i in agsv.supervise_once(self.store, "devin-root", set(), self.now)], ["blocked"])


class Mail(unittest.TestCase):
    def setUp(self):
        self.store = agsv.MemoryStore()
        fleet(self.store, ["a", "b"])
        self.root = {"id": "devin-root", "name": "root"}
        self.a = {"id": "devin-a", "name": "a", "parent": "devin-root"}

    def test_addressing_is_parent_child_only(self):
        self.assertEqual(agsv.resolve(self.store, "parent", self.a), "devin-root")
        self.assertEqual(agsv.resolve(self.store, "root", self.a), "devin-root")
        self.assertEqual(agsv.resolve(self.store, "a", self.root), "devin-a")
        self.assertEqual(agsv.resolve(self.store, "devin-b", self.root), "devin-b")
        with self.assertRaises(SystemExit) as cm:
            agsv.resolve(self.store, "devin-b", self.a)
        self.assertIn("only along parent<->child", str(cm.exception))
        with self.assertRaises(SystemExit):
            agsv.resolve(self.store, "nobody", self.root)

    def test_cursor_advances_after_delivery_and_replays_on_crash(self):
        agsv.post(self.store, agsv.make_message(self.root, "devin-a", "one"))
        agsv.post(self.store, agsv.make_message(self.root, "devin-a", "two"))
        cursor, sha = agsv.read_cursor(self.store, "devin-a")
        first = agsv.new_mail(self.store, "devin-a", cursor)
        self.assertEqual([m["text"] for m in first], ["one", "two"])
        # crash before advance: same mail again
        self.assertEqual(len(agsv.new_mail(self.store, "devin-a", cursor)), 2)
        agsv.advance(self.store, "devin-a", cursor, sha, first)
        cursor, sha = agsv.read_cursor(self.store, "devin-a")
        self.assertEqual(agsv.new_mail(self.store, "devin-a", cursor), [])
        agsv.post(self.store, agsv.make_message(self.root, "devin-a", "three"))
        self.assertEqual([m["text"] for m in agsv.new_mail(self.store, "devin-a", cursor)], ["three"])

    def test_waiting_send_takes_only_its_reply(self):
        q = agsv.make_message(self.a, "devin-root", "may I?", awaiting_until=agsv.now_ms() + 10 * S)
        agsv.post(self.store, q)
        agsv.post(self.store, agsv.make_message(self.root, "devin-a", "unrelated"))
        agsv.post(self.store, agsv.make_message(self.root, "devin-a", "yes", reply_to=q["id"]))
        cursor, sha = agsv.read_cursor(self.store, "devin-a")
        mail = agsv.new_mail(self.store, "devin-a", cursor)
        reply = next(m for m in mail if m.get("replyTo") == q["id"])
        agsv.advance(self.store, "devin-a", cursor, sha, [], [reply["id"]])
        cursor, _ = agsv.read_cursor(self.store, "devin-a")
        self.assertEqual([m["text"] for m in agsv.new_mail(self.store, "devin-a", cursor)], ["unrelated"])

    def test_send_wait_returns_reply_and_records_edge(self):
        import threading
        q_holder = {}

        def answer():
            for _ in range(100):
                mail = [m for m in self.store.snapshot("inbox/devin-root/").values()]
                if mail:
                    q_holder["q"] = mail[0]
                    a = agsv.all_agents(self.store)["devin-a"]
                    q_holder["edge"] = a["waits"]
                    agsv.post(self.store, agsv.make_message(self.root, "devin-a", "go ahead", reply_to=mail[0]["id"]))
                    return
                agsv.time.sleep(0.02)
        t = threading.Thread(target=answer)
        t.start()
        got = agsv.send(self.store, self.a, "parent", "may I?", wait_s=5, poll_s=0.05)
        t.join()
        self.assertEqual(got["text"], "go ahead")
        self.assertEqual(q_holder["edge"][0]["on"], "devin-root")
        self.assertEqual(agsv.all_agents(self.store)["devin-a"]["waits"], [])
        self.assertEqual(agsv.all_agents(self.store)["devin-a"]["status"], "working")

    def test_done_reports_to_parent_and_waiters(self):
        agsv.add_wait(self.store, "devin-b", "devin-a", "its api")
        agsv.done(self.store, self.a, "shipped it")
        root_mail = list(self.store.snapshot("inbox/devin-root/").values())
        b_mail = list(self.store.snapshot("inbox/devin-b/").values())
        self.assertEqual(root_mail[0]["kind"], "ended")
        self.assertEqual(b_mail[0]["text"], "shipped it")
        self.assertEqual(agsv.all_agents(self.store)["devin-a"]["status"], "done")

    def test_frame_tells_who_and_what(self):
        q = agsv.make_message(self.a, "devin-root", "may I?", awaiting_until=agsv.now_ms() + 90 * S)
        text = agsv.frame(q, "devin-root", agsv.now_ms())
        self.assertIn("blocked waiting for your reply", text)
        self.assertIn(f"--reply-to {q['id']}", text)
        self.assertIn("not your user", text)

    def test_memory_store_conflict(self):
        self.store.write("x.json", {"a": 1})
        with self.assertRaises(agsv.Conflict):
            self.store.write("x.json", {"a": 2})
        with self.assertRaises(agsv.Conflict):
            self.store.write("x.json", {"a": 2}, "wrong")


if __name__ == "__main__":
    unittest.main(verbosity=1)
