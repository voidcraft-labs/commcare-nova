"""Identify an individual observation of the republished HQ app by its actual inputs.

An uninterrupted lane only reports the digest. A focused run compares it before starting
the native operation, records its output separately and never writes a release observation.
"""

import os
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import cached_property
from hashlib import sha256
from pathlib import Path

from proof.lane import progress
from proof.observe.record import canonical

_context = ContextVar("diagnostic_b_context", default=None)
_path = ContextVar("diagnostic_editor_path", default="")
_expected = ContextVar("expected_diagnostic_stage", default=None)
READER_OPTIONS = Path(__file__).resolve().parents[1] / "core" / "answers.json"


def digest(data):
    return sha256(data).hexdigest()


@dataclass
class State:
    ctx: object

    @cached_property
    def key(self):
        from proof.observe.casedata import database_digest
        from proof.observe.proof4 import files_key

        ctx = self.ctx
        archive = ctx.archive
        files = (
            sorted((path, digest(data)) for path, data in archive["entries"])
            if archive and "entries" in archive else archive
        )
        values = [
            "hq-b-stage-v1", ctx.replay_b_key.hex(), ctx.document.id, ctx.configuration_name, files_key(ctx.build).decode(),
            files, database_digest(ctx.sessions[0]), digest(ctx.restore) if ctx.restore is not None else None,
            ctx.declared_inputs, digest(READER_OPTIONS.read_bytes()), os.environ.get("PROOF_IMAGE_ID"),
            getattr(ctx.store, "scope", None),
        ]
        return digest(canonical(values))


def wants_receipts(document, store):
    if not getattr(store, "scope", None) or not getattr(store, "seeded", False) or not os.environ.get("PROOF_IMAGE_ID"):
        return False
    if _expected.get() is not None:
        return True
    return (
        os.environ.get("PROOF_CHECKPOINT_PARTS") == "1"
        and document.kind == "corpus"
        and os.environ.get("PROOF_GROUP", "").partition("@")[0] == document.group
    )


@contextmanager
def baseline(ctx):
    from proof.observe.unit import BContext

    token = _context.set(State(ctx) if isinstance(ctx, BContext) and ctx.replay_b_key is not None else None)
    try:
        yield
    finally:
        _context.reset(token)


@contextmanager
def expecting(scope, key, on_input=None):
    """A selected stage must actually run on matching inputs, including where an editor did not offer a save."""
    found = []
    token = _expected.set((scope, key, found, on_input))
    try:
        yield found
        if not found:
            raise ValueError(f"The requested stage {scope!r} was not offered by this release.")
    finally:
        _expected.reset(token)


def selected_editor():
    expected = _expected.get()
    return expected[0] if expected and expected[0].startswith(("page/", "vellum/")) else None


def selected_saved_reader():
    editor = selected_editor()
    if not editor or not any(segment in editor for segment in ("/first/", "/second/", "/section/")):
        return None
    return editor


def in_save():
    return bool(_path.get())


def saved_reader_scope(reader):
    return f"{_path.get()}/{reader}"


def select_saved_reader(serving, side, trace, *, client_changed):
    """Return the selected native evidence to the diagnostic entry, or let preparation reach its next save."""
    from proof.observe.served import observes_state

    selected = selected_saved_reader()
    if selected == saved_reader_scope("formplayer"):
        raise Captured(side)
    if selected == saved_reader_scope("webapps") and client_changed:
        if serving.driver is not None and observes_state("webapps", serving.served):
            raise Captured(serving.webapps(trace, baseline=True))
    for device in ("phone", "tablet"):
        if selected == saved_reader_scope(f"android/{device}") and observes_state("android", serving.served):
            raise Captured(serving.android("save", device=device))


class Captured(BaseException):
    """The requested saved-state observation finished. Unwind its HQ forks before returning the diagnostic."""

    def __init__(self, result):
        self.result = result


@contextmanager
def save(segment):
    path = _path.get()
    token = _path.set(f"{path}/{segment}" if path else "")
    try:
        yield
    finally:
        _path.reset(token)


@contextmanager
def operation(label, scope, inputs, *, count=None):
    """Record the original request, bound to its B and exact position within the selected editor."""
    state = _context.get()
    expected = _expected.get()
    if state is None or (expected is None and not progress.is_reporting()):
        with progress.activity(label, count=count):
            yield
        return
    editor = scope.startswith(("vellum/", "page/"))
    scope = saved_reader_scope(scope) if _path.get() and not editor else scope
    key = digest(canonical([state.key, scope, inputs()]))
    if expected is not None and expected[0] == scope:
        if expected[3] is not None:
            expected[3](key)
        if expected[1] is not None and expected[1] != key:
            raise ValueError(f"{scope}: rebuilt input digest {key} differs from the checkpoint {expected[1]}.")
        if expected[2]:
            raise ValueError(f"{scope}: a selected native operation ran twice.")
        expected[2].append(key)
    token = _path.set(scope if editor else _path.get())
    try:
        with progress.activity(label, input_sha256=key, input_scope=scope, count=count):
            yield
    finally:
        _path.reset(token)
