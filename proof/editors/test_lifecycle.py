"""The editor driver process: it starts or fails loudly, honours deadlines, and is always joined.

Each test owns its own driver, since a deadline or a driver that dies takes
the shared one with it. None needs HQ: the pages here are the image's own
static files, and the driver's requests to HQ are answered by the test.
Chromium runs outside the driver's process group, so the tests that stop a
driver also check that every process it started (Chromium's among them) has
ended.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from proof.editors import client
from proof.editors.client import (
    EditorDeadlineError,
    EditorDriver,
    EditorDriverError,
    EditorDriverStartError,
    PageResponse,
    has_exited,
)
from proof.editors.conftest import record_timing
from proof.editors.vellum import HOST_PAGE

LOADED = [{"goto": HOST_PAGE}, {"waitFor": "document.readyState === 'complete' && !!window.proofVellumHost"}]
# Where the image keeps Playwright's Chromium; every browser process's command names it.
PLAYWRIGHT_BROWSERS = b"/opt/ms-playwright/"


def _nothing_from_hq(request):
    return PageResponse(404, [("Content-Type", "text/plain")], b"")


def test_the_driver_announces_chromium_and_serves_the_editor_build():
    with EditorDriver() as driver:
        record_timing("driver_start", driver.timings.starts[0])
        assert driver.ready["playwright"] == "1.63.0"
        result = driver.run(
            LOADED + [{"eval": "() => typeof window.proofVellumHost.pageOptions"}], answer=_nothing_from_hq
        )
    assert result["outcomes"][-1]["value"] == "function"
    assert result["pageErrors"] == []


# A page function that throws ``thrown`` (a JavaScript expression) from a timer, uncaught, and resolves after it.
THROWS = "() => new Promise((resolve) => setTimeout(() => {{ setTimeout(resolve, 0); throw {thrown}; }}, 0))"


def test_a_page_error_is_what_the_page_threw():
    # Vellum throws strings (parser.js::_getInstances, ``'PARSE ERROR!:' + ...``), which Playwright's pageerror hands
    # on as an Error split at the string's first colon and with no stack; the driver records the thrown string
    # itself, and an Error by V8's description of it (its name, message and stack).
    parse_error = "PARSE ERROR!:<div>no</div>"
    with EditorDriver() as driver:
        result = driver.run(
            LOADED
            + [
                {"eval": THROWS.format(thrown=repr(parse_error))},
                {"eval": THROWS.format(thrown="new TypeError('nothing to read')")},
            ],
            answer=_nothing_from_hq,
        )
    thrown, error = result["pageErrors"]
    assert thrown == parse_error
    assert error.startswith("TypeError: nothing to read\n    at "), error


def _chromium(driver):
    """The processes the running driver started, with the Chromium browser among them."""
    started = driver.descendants()
    commands = [Path(f"/proc/{pid}/cmdline").read_bytes() for pid in started]
    assert any(PLAYWRIGHT_BROWSERS in command for command in commands), commands
    return started


def test_the_driver_is_joined_when_the_client_closes_after_a_failure():
    driver = EditorDriver()
    with pytest.raises(RuntimeError, match="a failing test"):
        with driver:
            process = driver.process
            threads = driver.reader_threads
            started = _chromium(driver)
            assert driver.alive
            raise RuntimeError("a failing test")
    assert process.returncode == 0
    assert not any(thread.is_alive() for thread in threads)
    assert not driver.alive
    assert [pid for pid in started if not has_exited(pid)] == []


def test_a_driver_without_the_editor_build_does_not_start(tmp_path):
    driver = EditorDriver(editors_dir=tmp_path)
    with pytest.raises(EditorDriverStartError, match="build.json"):
        with driver:
            pass
    assert driver.process is None


def test_a_driver_that_exits_before_it_is_ready_fails_the_start(tmp_path):
    script = tmp_path / "driver.mjs"
    script.write_text('process.stderr.write("no Chromium here\\n"); process.exit(3);\n')
    driver = EditorDriver(driver=script)
    with pytest.raises(EditorDriverStartError, match="no Chromium here"):
        with driver:
            pass
    assert driver.process is None


def test_a_step_past_its_deadline_fails_by_name_and_the_driver_keeps_serving():
    with EditorDriver() as driver:
        first = driver.process
        with pytest.raises(EditorDeadlineError) as breached:
            driver.run(LOADED + [{"waitFor": "false"}], answer=_nothing_from_hq, deadline=3)
        assert breached.value.kind == "deadline"
        assert "Step 2" in str(breached.value)
        assert driver.process is first and driver.alive
        driver.run(LOADED, answer=_nothing_from_hq)
        assert driver.restarts == 0


def test_a_wait_looks_in_the_page_until_it_holds_carries_on_across_a_navigation_and_fails_on_its_own_error():
    """A step's wait runs inside the page (driver.mjs::waitInPage): it holds once the page makes it hold, a wait
    whose document is replaced under it carries on in the next document (as Playwright's waitForFunction does),
    and a predicate that throws fails its step at once, not at the deadline. A "waitFor" expression whose value is
    a function is that function, called with the step's "arg" at every look (the driver's rule,
    driver.mjs::waiterExpression; Playwright's own string form takes the function itself as a value that holds at
    once, before the page has set anything)."""
    navigated = "/static/vellum/host.html?again"
    with EditorDriver() as driver:
        result = driver.run(
            LOADED
            + [
                {"eval": "() => { setTimeout(() => { window.proofLater = 'set'; }, 100); }"},
                {"until": "vellum/host_ready"},
                {"waitFor": "(name) => window[name] === 'set'", "arg": "proofLater"},
                {"eval": "() => window.proofLater ?? null"},
                {"eval": f"() => {{ setTimeout(() => {{ window.location.href = {navigated!r}; }}, 50); }}"},
                {"waitFor": "window.location.search === '?again' && document.readyState === 'complete'"},
                {"eval": "() => [window.location.pathname + window.location.search, window.proofLater ?? null]"},
            ],
            answer=_nothing_from_hq,
            deadline=20,
        )
        # The function-valued wait held only once the page had set what it looks at.
        assert result["outcomes"][5]["value"] == "set"
        assert result["outcomes"][-1]["value"] == [navigated, None]
        with pytest.raises(EditorDriverError) as broke:
            driver.run(
                LOADED + [{"waitFor": "() => { throw new Error('the predicate broke'); }"}],
                answer=_nothing_from_hq,
                deadline=30,
            )
        assert broke.value.kind == "page" and "the predicate broke" in str(broke.value)
        assert broke.value.detail["failedStep"] == 2 and broke.value.detail["run"]["seconds"] < 10


def test_a_driver_that_stops_answering_is_stopped_and_the_next_run_starts_a_fresh_one(monkeypatch):
    monkeypatch.setattr(client, "CLIENT_GRACE_SECONDS", 1.0)
    with EditorDriver() as driver:
        first = driver.process
        started = _chromium(driver)
        # The page never returns control, so neither does the driver.
        with pytest.raises(EditorDeadlineError, match="the client stopped it"):
            driver.run(LOADED + [{"eval": "() => { for (;;) {} }"}], answer=_nothing_from_hq, deadline=3)
        assert first.returncode is not None and not driver.alive
        # The forced stop reached Chromium, outside the driver's process group.
        assert [pid for pid in started if not has_exited(pid)] == []
        driver.run(LOADED, answer=_nothing_from_hq)
        assert driver.restarts == 1 and driver.process is not first


# A stand-in driver that announces itself, then answers every operation with a
# line that is not the protocol: what the client would read if anything in the
# driver wrote to standard output.
STRAY_DRIVER = """
process.stdout.write(JSON.stringify({ready: true}) + "\\n");
process.stdin.on("data", () => process.stdout.write("a line that is not the protocol\\n"));
"""


def test_a_line_that_is_not_the_protocol_fails_its_run_by_name_and_stops_the_driver(tmp_path):
    script = tmp_path / "driver.mjs"
    script.write_text(STRAY_DRIVER)
    with EditorDriver(driver=script) as driver:
        first = driver.process
        with pytest.raises(EditorDriverError, match="not a JSON object") as stray:
            driver.run(LOADED, answer=_nothing_from_hq)
        assert "a line that is not the protocol" in str(stray.value)
        assert first.returncode is not None and not driver.alive
    assert driver.process is None


def test_an_answer_that_raises_stops_the_driver_and_reaches_the_caller():
    def broken(request):
        raise LookupError("the test's HQ could not answer")

    with EditorDriver() as driver:
        first = driver.process
        with pytest.raises(LookupError, match="could not answer"):
            driver.run([{"goto": "/a/nowhere/"}], answer=broken)
        assert first.returncode is not None and not driver.alive
        driver.run(LOADED, answer=_nothing_from_hq)
        assert driver.restarts == 1


def test_a_forced_stop_that_leaves_a_killed_process_running_fails_by_its_pid(monkeypatch):
    # A process that outlives SIGKILL is held in the kernel, which a test cannot arrange: the processes the stop
    # killed are waited for as they really end, and then reported as still running.
    reported = []
    await_ended = client._await_ended

    def ended_late(watched, seconds):
        assert await_ended(watched, seconds) == []
        reported.extend(sorted(watched.values()))
        return reported

    def broken(request):
        raise LookupError("the test's HQ could not answer")

    with EditorDriver() as driver:
        started = _chromium(driver)
        monkeypatch.setattr(client, "_await_ended", ended_late)
        with pytest.raises(EditorDriverError, match="still running") as failed:
            driver.run([{"goto": "/a/nowhere/"}], answer=broken)
        monkeypatch.undo()
        # Each process the stop killed is named (Chromium's among them), the answer's own error is the one the
        # stop failed while handling, and the driver is put away all the same: the next run starts a fresh one.
        assert set(started) & set(reported)
        assert all(f"{pid} (" in str(failed.value) for pid in reported)
        assert isinstance(failed.value.__context__, LookupError)
        assert driver.process is None and not driver.alive
        driver.run(LOADED, answer=_nothing_from_hq)
        assert driver.restarts == 1


def test_a_page_hq_answers_with_an_error_fails_its_run_at_once_by_its_status():
    def failing(request):
        return PageResponse(500, [("Content-Type", "text/plain")], b"")

    def answering(request):
        return PageResponse(200, [("Content-Type", "text/html; charset=utf-8")], b"<!doctype html><p id=hq>HQ</p>")

    with EditorDriver() as driver:
        opened = driver.run(
            [{"goto": "/a/proof/apps/"}, {"eval": "() => document.getElementById('hq').textContent"}],
            answer=answering,
            deadline=10,
        )
        assert opened["outcomes"][0]["status"] == 200 and opened["outcomes"][1]["value"] == "HQ"
        with pytest.raises(EditorDriverError, match="answered with status 500") as failed:
            driver.run([{"goto": "/a/proof/apps/"}, {"waitFor": "false"}], answer=failing, deadline=60)
        assert failed.value.kind == "page"
        # It failed at the page, not at the next step's deadline.
        assert failed.value.detail["failedStep"] == 0 and failed.value.detail["run"]["seconds"] < 10
        assert driver.alive and driver.restarts == 0
