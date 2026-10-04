"""Fixtures for the native proofs (proof/README.md, "Native proofs").

- ``native``: the session's ``NativeSession``, which runs each family's
  producer, HQ step and Core build once and keeps what they made. It first
  produces, several at a time, every family the selected tests name in
  their module's ``FAMILIES``. Its HQ is the session's one boot (the root
  conftest's ``hq``, which drops the template database HQ's first check
  restored when the session ends), and its Core runner (the root conftest's
  ``core_runner``, answering Formplayer's form validation for HQ) starts
  only when HQ first asks to validate a form. At the end of the session it
  removes what it fetched (the Connect checkout), and prints and writes
  (``$PROOF_OUT/native/timings.json``) what each part cost.

Every test fails if HQ reached for the network during it (the root
conftest's ``network``); the steps a session fixture runs check the same
inside ``NativeSession.step``.
"""

from __future__ import annotations

import json
import time

import pytest

from proof.native.session import NativeSession, native_output_dir

_SESSION: dict[str, object] = {}


def pytest_collection_modifyitems(items):
    """Note the families the selected native tests read (each module's ``FAMILIES``), to produce them together."""
    families = set()
    for item in items:
        module = getattr(item, "module", None)
        if module is not None and module.__name__.startswith("proof.native."):
            families.update(getattr(module, "FAMILIES", ()))
    _SESSION["families"] = families


@pytest.fixture(scope="session")
def native(request, hq):
    started = time.perf_counter()
    session = NativeSession(native_output_dir(), lambda: request.getfixturevalue("core_runner"))
    _SESSION["native"] = session
    try:
        session.prefetch(sorted(_SESSION.get("families", ())))
        yield session
    finally:
        session.close()
        session.timings["session"] = round(time.perf_counter() - started, 3)


def pytest_terminal_summary(terminalreporter):
    session = _SESSION.get("native")
    if session is None or not session.timings:
        return
    terminalreporter.section("Native proof timings (seconds)")
    for name, seconds in sorted(session.timings.items()):
        terminalreporter.write_line(f"{name}: {seconds}")
    (session.out / "timings.json").write_text(json.dumps(session.timings, indent="\t", sort_keys=True) + "\n")
