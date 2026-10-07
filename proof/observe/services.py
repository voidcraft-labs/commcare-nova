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
- ``client_browser()``: an editor driver (node and Chromium) of the Web
  Apps client's own. Proof 4 shows a saved app in the client while the
  editor page that saved it is still open in the session's editor driver,
  mid-run, each save released into a fork of its own; a driver runs one
  operation at a time, so the client has a second browser, as a worker's
  is another browser than the person's who edits the app.
"""

from __future__ import annotations

from contextlib import contextmanager

_SESSION: dict = {"open": False, "formplayer": None, "browser": None}


class NoSession(RuntimeError):
    """An observation asked for the session's Formplayer outside a session that owns one."""


@contextmanager
def session(on_start=None):
    """The lifetime of the session's services; ``on_start(runner)`` is told each runner as it starts."""
    if _SESSION["open"]:
        raise NoSession("The session's services are already open in this process; one session owns them.")
    _SESSION.update(open=True, formplayer=None, browser=None, on_start=on_start)
    try:
        yield
    finally:
        runner, _SESSION["formplayer"] = _SESSION["formplayer"], None
        browser, _SESSION["browser"] = _SESSION["browser"], None
        _SESSION["open"] = False
        try:
            if browser is not None:
                browser.close()
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
