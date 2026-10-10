"""The session's Formplayer and the Web Apps client's browser, for the observations that are served to them.

A document's observation serves each state of its app to Formplayer and
shows it in the Web Apps client (``proof.observe.served``), from inside the
unit, where no test's fixtures reach. pytest still owns each service's
lifetime: the session's fixture (``proof/conftest.py::lane_services``) opens
``session()`` for the whole session and closes it when the session ends,
and each service starts the first time an observation or a test asks for it
(a session whose checks never ask starts none). Outside such a session
there is none, and asking raises.

- ``formplayer()``: the session's one Formplayer runner.
- ``validator()``: the Formplayer that answers the form validation HQ asks
  for while it builds an app, saves a form or maps media
  (``proof.hq.seams.form_validation``), a runner of its own: Formplayer
  answers one request at a time, and HQ may build while it answers a
  request of the session's Formplayer.
- ``connect()``: the session's one Connect runtime (``proof.connect.runtime``:
  Connect at its pin, its Postgres and Redis, its migrated database), which
  a Connect document's observation serves an opportunity from
  (``proof.observe.connect``). Its logs go under the run's output
  (``$PROOF_OUT/connect-unit``).
- ``android()``: the session's Android reader (``proof.android.client``:
  commcare-android's own code under Robolectric, one JVM and one device a
  request), which reads each served state beside HQ's unit, its network
  answered by HQ's own views (``proof.android.hq``). It runs where
  Robolectric's native runtime does (linux/amd64, where the lane's shards
  run, and macOS), from the runtime ``PROOF_ANDROID_RUNTIME`` names; asking
  for it anywhere else raises with the reason.
- ``client_browser()``: an editor driver (node and Chromium) of the Web
  Apps client's own. Proof 4 shows a saved app in the client while the
  editor page that saved it is still open in the session's editor driver,
  mid-run, each save released into a fork of its own; a driver runs one
  operation at a time, so the client has a second browser, as a worker's
  is another browser than the person's who edits the app.
"""

from __future__ import annotations

from contextlib import contextmanager

_SESSION: dict = {
    "open": False,
    "formplayer": None,
    "validator": None,
    "browser": None,
    "connect": None,
    "android": None,
}


class NoSession(RuntimeError):
    """An observation asked for the session's Formplayer outside a session that owns one."""


@contextmanager
def session(on_start=None):
    """The lifetime of the session's services; ``on_start(runner)`` is told each runner as it starts."""
    if _SESSION["open"]:
        raise NoSession("The session's services are already open in this process; one session owns them.")
    _SESSION.update(
        open=True, formplayer=None, validator=None, browser=None, connect=None, android=None, on_start=on_start
    )
    try:
        yield
    finally:
        reader, _SESSION["android"] = _SESSION["android"], None
        if reader is not None:
            reader.close()
        runner, _SESSION["formplayer"] = _SESSION["formplayer"], None
        validating, _SESSION["validator"] = _SESSION["validator"], None
        browser, _SESSION["browser"] = _SESSION["browser"], None
        connect_runtime, _SESSION["connect"] = _SESSION["connect"], None
        _SESSION["open"] = False
        try:
            if browser is not None:
                browser.close()
        finally:
            try:
                if connect_runtime is not None:
                    connect_runtime.close()
            finally:
                try:
                    if validating is not None:
                        validating.close()
                finally:
                    if runner is not None:
                        runner.close()


def _require_session(what):
    if not _SESSION["open"]:
        raise NoSession(
            f"A document's observation serves its app to {what}, and no session owns one here. Run it under"
            " pytest (proof/conftest.py::lane_services opens the session's services), or open"
            " proof.observe.services.session() around it."
        )


def client_browser():
    """The Web Apps client's own editor driver (node and Chromium), started on first use."""
    _require_session("the Web Apps client's browser")
    if _SESSION["browser"] is None:
        from proof.editors.client import EditorDriver

        driver = EditorDriver()
        try:
            driver.start()
        except BaseException:
            driver.close()
            raise
        _SESSION["browser"] = driver
    return _SESSION["browser"]


def formplayer():
    """The session's Formplayer runner, started on first use."""
    _require_session("Formplayer")
    if _SESSION["formplayer"] is None:
        from proof.formplayer.client import FormplayerRunner

        runner = FormplayerRunner()
        try:
            runner.start()
        except BaseException:
            runner.close()
            raise
        _SESSION["formplayer"] = runner
        if _SESSION.get("on_start") is not None:
            _SESSION["on_start"](runner)
    return _SESSION["formplayer"]


def validator():
    """The Formplayer that answers HQ's form validation, started on first use: a runner of its own beside the
    session's, since a Formplayer answers one request at a time and HQ may build while the session's is waiting
    on one of HQ's own answers."""
    _require_session("Formplayer's form validation")
    if _SESSION["validator"] is None:
        from proof.formplayer.client import FormplayerRunner

        runner = FormplayerRunner()
        try:
            runner.start()
        except BaseException:
            runner.close()
            raise
        _SESSION["validator"] = runner
    return _SESSION["validator"]


def connect():
    """The session's Connect runtime, started on first use (its fetch and its migrations, once a session)."""
    _require_session("Connect")
    if _SESSION["connect"] is None:
        import os
        import tempfile
        from pathlib import Path

        from proof.connect.runtime import ConnectRuntime

        out = os.environ.get("PROOF_OUT")
        logs = Path(out) / "connect-unit" if out else Path(tempfile.mkdtemp(prefix="proof-connect-unit-"))
        runtime = ConnectRuntime(logs)
        runtime.__enter__()
        _SESSION["connect"] = runtime
    return _SESSION["connect"]


def android():
    """The session's Android reader, started on first use (its sources compiled against the runtime, once)."""
    _require_session("the Android reader")
    if _SESSION["android"] is None:
        from proof.android.client import AndroidReader

        reader = AndroidReader()
        try:
            reader.start()
        except BaseException:
            reader.close()
            raise
        _SESSION["android"] = reader
    return _SESSION["android"]
