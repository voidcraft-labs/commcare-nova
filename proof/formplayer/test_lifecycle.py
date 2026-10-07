"""The runner's processes: a deadline ends the JVM, a fresh one follows, and everything is joined.

Each test owns its own runner, since a deadline or an unanswered request of
HQ ends the JVM the session's other tests share.

Contracts (``proof.formplayer.client``):

- **A request past its deadline fails, and the next runs on a fresh
  Formplayer.** The JVM halts with the deadline's exit status; the next
  request starts another, on a database and a Redis of its own. Plausible
  failure: a client left waiting on a Formplayer that will not answer, or a
  second Formplayer reading the first's sessions.
- **A request of HQ the caller does not answer ends the request with the
  caller's error.** Plausible failure: the error swallowed and Formplayer
  answered with nothing, so an observation would read a refusal as the app's.
- **Closing joins everything.** The JVM, its reader threads and Redis have
  exited and the database is gone. Plausible failure: a Redis or a JVM left
  running after a failed test, holding a worker's memory.
"""

from __future__ import annotations

import pytest

from proof.formplayer import client
from proof.formplayer.client import (
    FormplayerDeadlineError,
    FormplayerRunner,
    FormplayerRunnerError,
)

# Exit status of a runner that halted on a deadline (Runner.DEADLINE_EXIT).
DEADLINE_EXIT = 75
NAVIGATION = {"domain": "proof", "username": "worker", "app_id": "app"}
SESSION = [("Cookie", "sessionid=key; XSRF-TOKEN=t"), ("X-XSRF-TOKEN", "t")]


def _database_exists(name):
    status, output = client._psql(f"SELECT 'found' FROM pg_database WHERE datname = '{name}'")
    assert status == 0, output
    return "found" in output


def test_a_request_past_its_deadline_fails_and_the_next_runs_on_a_fresh_formplayer():
    with FormplayerRunner() as runner:
        first, first_database, first_port = runner.process, runner._database, runner.ready["port"]
        assert runner.http("/serverup", method="GET").response.status == 200
        with pytest.raises(FormplayerDeadlineError) as breached:
            runner.http("/serverup", method="GET", deadline=0.0001)
        assert breached.value.kind == "deadline"
        assert first.poll() == DEADLINE_EXIT
        assert runner.http("/serverup", method="GET").response.status == 200
        assert runner.process is not first and runner.restarts == 1
        assert runner._database != first_database and not _database_exists(first_database)
        assert _database_exists(runner._database)
        assert runner.ready["port"] != first_port or runner.process.pid != first.pid


def test_a_request_of_hq_the_caller_does_not_answer_raises_the_callers_error_and_closing_joins_everything():
    runner = FormplayerRunner()
    try:
        runner.start()
        process, redis, database, threads = (
            runner.process,
            runner.redis_process,
            runner._database,
            runner.reader_threads,
        )
        # Formplayer asks HQ who the session is before it serves a navigation; this runner answers nothing.
        with pytest.raises(FormplayerRunnerError, match="asked HQ for POST /hq/admin/session_details/"):
            runner.http("/navigate_menu", NAVIGATION, headers=SESSION)
        assert process.poll() is not None
        # The accepted case: the same request, with HQ answering that it knows no such session, is Formplayer's
        # own refusal, on a fresh JVM.
        refused = runner.http("/navigate_menu", NAVIGATION, headers=SESSION, hq=lambda request: client.HqAnswer(404))
        assert refused.response.status in (401, 403)
        assert [request.path for request, _ in refused.hq] == ["/hq/admin/session_details/"]
        process, redis, database, threads = (
            runner.process,
            runner.redis_process,
            runner._database,
            runner.reader_threads,
        )
    finally:
        runner.close()
    assert process.poll() is not None
    assert redis.returncode is not None
    assert not any(thread.is_alive() for thread in threads)
    assert not _database_exists(database)
    assert runner.process is None and runner.redis_process is None
