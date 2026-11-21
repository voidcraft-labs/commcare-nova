"""The client's side of a callback: a question the runner asks while a request runs is answered by its handler.

Contract: a line the JVM writes naming the running request and a callback
is answered with the handler the request was sent with, as one line on the
JVM's input, and the request's own answer is read after it
(``client.py::CoreRunner._send``, ``Runner.java::ask``); a callback the
request has no handler for, or a handler that raises, stops the JVM and
ends the request, never answers the JVM with anything else, and the next
request starts a fresh JVM. ``search_answers`` hands the JVM HQ's status and
body for a search's parameters. The plausible failures: a callback line read
as the request's answer (the protocol out of step); a JVM left waiting for
an answer the client never sends; a body sent as text, which a binary answer
would not survive.

The JVM here is a stand-in in this process that speaks the protocol on the
client's own pipes (``FakeJvm``), so these run with no image and no java; the
runner's own half is held by
``test_session.py::test_a_search_a_handler_answers_lists_the_cases_the_answer_holds_whatever_the_case_data_holds``,
which runs Core.
"""

from __future__ import annotations

import base64
import json
import queue

import pytest

from proof.core.client import (
    MAIN_CLASS_FILE,
    CoreRunner,
    CoreRunnerError,
    callback_of,
    search_answers,
)


class FakeJvm:
    """A JVM that speaks the protocol: each request's every question it names in ``ask`` is written as a callback
    line and answered by the client's next line, then the request's answer, which holds the answers it read."""

    def __init__(self, lines: queue.SimpleQueue):
        self.lines = lines
        self.returncode = None
        self.waiting = None  # the request whose questions are being asked: (request, answers, questions left)
        self.stdin = self
        self.stdout = self.stderr = None

    # The client's writes, one JSON line each.
    def write(self, data: bytes) -> None:
        for line in data.decode("utf-8").splitlines():
            self._read(json.loads(line))

    def flush(self) -> None:
        pass

    def close(self) -> None:
        pass

    def _say(self, value) -> None:
        self.lines.put(json.dumps(value).encode("utf-8") + b"\n")

    def _read(self, value) -> None:
        if self.waiting is not None:
            request, answers, left = self.waiting
            answers.append(value)
            self._next(request, answers, left)
            return
        if value["op"] == "shutdown":
            self._say({"id": value["id"], "ok": True, "result": {}})
            self.returncode = 0
            return
        self._next(value, [], list(value.get("ask", [])))

    def _next(self, request, answers, left) -> None:
        if left:
            asked = left.pop(0)
            self.waiting = (request, answers, left)
            self._say({"id": request["id"], "callback": asked["callback"], "question": asked["question"]})
            return
        self.waiting = None
        self._say({"id": request["id"], "ok": True, "result": {"answers": answers}})

    # What the client asks of its process.
    def poll(self):
        return self.returncode

    def kill(self) -> None:
        self.returncode = -9

    def wait(self):
        return self.returncode


class FakeRunner(CoreRunner):
    """A ``CoreRunner`` whose every JVM is a ``FakeJvm``."""

    def _launch(self) -> None:
        lines: queue.SimpleQueue = queue.SimpleQueue()
        self._process, self._stdout_lines, self._threads = FakeJvm(lines), lines, []
        self._generation += 1


@pytest.fixture
def runner(tmp_path):
    classes = tmp_path / "classes"
    (classes / MAIN_CLASS_FILE).parent.mkdir(parents=True)
    (classes / MAIN_CLASS_FILE).write_bytes(b"")
    with FakeRunner(classes=classes) as started:
        yield started


def ask(*questions):
    return [{"callback": name, "question": question} for name, question in questions]


def test_each_question_a_request_asks_is_answered_by_its_handler_before_the_requests_own_answer(runner):
    seen = []

    def search(question):
        seen.append(question)
        return {"echo": question["n"]}

    result = runner.request(
        "session",
        deadline=10.0,
        callbacks={"search": search},
        ask=ask(("search", {"n": 1}), ("search", {"n": 2})),
    )
    assert seen == [{"n": 1}, {"n": 2}]
    assert result["answers"] == [
        {"callback": "search", "answer": {"echo": 1}},
        {"callback": "search", "answer": {"echo": 2}},
    ]
    # A request that asks nothing is answered as before, by the same JVM.
    assert runner.request("session", deadline=10.0)["answers"] == []
    assert runner.restarts == 0


def test_a_question_the_request_has_no_handler_for_stops_the_jvm_and_the_next_request_starts_a_fresh_one(runner):
    with pytest.raises(CoreRunnerError, match="no handler"):
        runner.request("session", deadline=10.0, ask=ask(("search", {"n": 1})))
    assert not runner.alive
    assert runner.request("session", deadline=10.0)["answers"] == []
    assert runner.restarts == 1


def test_a_handler_that_raises_stops_the_jvm_and_its_error_ends_the_request(runner):
    class Refused(Exception):
        pass

    def search(question):
        raise Refused("the harness refused")

    with pytest.raises(Refused):
        runner.request("session", deadline=10.0, callbacks={"search": search}, ask=ask(("search", {"n": 1})))
    assert not runner.alive
    assert runner.request("session", deadline=10.0)["answers"] == []


def test_a_line_is_a_callback_only_where_it_names_the_running_request_and_a_question():
    assert callback_of(b'{"id": 3, "callback": "search", "question": {"url": null}}', 3) == (
        "search",
        {"url": None},
    )
    # The request's own answer, another request's line, a line with no question, and silence are no callback.
    assert callback_of(b'{"id": 3, "ok": true, "result": {}}', 3) is None
    assert callback_of(b'{"id": 2, "callback": "search", "question": {}}', 3) is None
    assert callback_of(b'{"id": 3, "callback": "search"}', 3) is None
    assert callback_of(None, 3) is None


def test_a_search_answer_carries_hqs_status_and_its_bytes_whole():
    body = bytes(range(256))
    asked = []

    def answer(url, params):
        asked.append((url, params))
        return 400, body

    handler = search_answers(answer)
    question = {"url": "https://hq/a/d/phone/search/x/", "params": {"_xpath_query": ["a = 'b'"], "case_type": ["c"]}}
    answered = handler(question)
    assert asked == [(question["url"], question["params"])]
    assert answered["status"] == 400
    assert base64.b64decode(answered["bodyBase64"]) == body

    with pytest.raises(CoreRunnerError, match="not lists of strings"):
        handler({"url": None, "params": {"case_type": "c"}})
