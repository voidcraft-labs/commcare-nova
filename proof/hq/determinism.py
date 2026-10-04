"""Seeded entropy and a frozen clock for HQ: identical keys give identical bytes.

``operation(key, depth)`` runs its block as one HQ operation whose every
random draw and every reading of the clock is a function of ``key`` and
``depth`` alone, so the same operation over the same state produces the same
bytes in any process, on any run.

Entropy. Inside the block, on the thread that opened it, each draw comes from
one HMAC-SHA256 DRBG (NIST SP 800-90A's HMAC_DRBG, instantiated with ``key``
as its seed material and never reseeded), in draw order. The draws HQ makes
on the lane's paths all reach one of these, each patched where every caller
reads it:

- ``os.urandom``, which ``uuid.uuid4`` reads (HQ's ids: the form ids
  ``app_manager/util.py::update_form_unique_ids`` re-mints on every import,
  ``Application.scrub_source``, saved builds, ``BlobMeta`` keys through
  ``corehq/blobs/models.py::uuid4_hex``, Celery's task ids), and which
  ``corehq/blobs/util.py::random_url_id`` (blob keys) and
  ``corehq/util/quickcache.py::_quickcache_id`` read directly;
- ``random._urandom``, which ``random.SystemRandom`` reads, and through it
  ``secrets`` and Django's ``get_random_string`` (session keys, and CSRF
  tokens and their masks; those Django mints while the editors' page
  requests are answered are drawn from each request's digest instead,
  ``proof.editors.hq.csrf_drawn_from``, so a page HQ renders alike in two
  states carries the same token);
- ``uuid.getnode``, the node ``uuid.uuid1`` stamps (fakecouch's document ids
  and ``_rev`` suffixes, ``fakecouch.py::FakeCouchDb.save_doc`` and
  ``_next_rev``): drawn once per scope the way ``uuid._random_getnode``
  draws one. ``uuid1``'s clock sequence comes from the global ``random``
  below, its time from the frozen clock, and the clock's own monotonic guard
  (``uuid._last_timestamp``) starts empty in each scope and is put back after;
  time-machine sets ``uuid._generate_time_safe`` to None while it travels,
  so ``uuid1`` never asks the system's generator;
- the global ``random`` instance (``random.random``, ``choice``,
  ``getrandbits``: HQ's ``models/base.py`` backup keys, ``uuid1``'s clock
  sequence), seeded from the DRBG and restored to its outside state after;
- ``tempfile``'s name sequence, which keeps a ``random.Random`` of its own
  seeded by the system (``tempfile._RandomNameSequence``); HQ names temporary
  files with it (``hqmedia/tasks.py``'s bulk upload).

A ``random.Random()`` constructed inside the block without a seed is seeded
by the system below Python and is not covered; HQ constructs none on the
lane's paths.

Threads. ``os.urandom``, ``random._urandom`` (``SystemRandom``, ``secrets``,
``get_random_string``) and ``uuid.getnode`` answer by thread: on any thread
but the block's they are the system's, and a draw there leaves the block's
sequence as it was. The global ``random`` state, ``tempfile``'s name
sequence and ``uuid1``'s timestamp guard belong to the whole process: while
an operation is open, a draw from them on another thread takes the
operation's next value and shifts every draw after it. Harness threads that
run while an operation is open (the Core runner's and the editor driver's
stream readers) draw from none of them.

Clock. The block runs inside ``time_machine.travel(EPOCH + depth seconds,
tick=False)``: ``time.time``, ``datetime.now`` and every other wall-clock
reader see that one instant, whatever the operation does. time-machine 2.17
(HQ's lock) also freezes ``time.monotonic``; it does not freeze
``time.perf_counter``. Python code that waits for a deadline inside an
operation must therefore measure with ``time.perf_counter`` or wait in C:
``queue.SimpleQueue.get(timeout=)``, ``threading.Event.wait``,
``threading.Condition.wait``, ``Thread.join``, ``selectors``. A deadline kept
with ``time.monotonic`` never arrives, and so do the timeouts of
``subprocess.run``, ``Popen.wait``, ``Popen.communicate`` and
``queue.Queue.get``, which all count down with ``time.monotonic``: each waits
for as long as its peer takes, and forever for one that never answers.

Nesting. An ``operation`` opened inside another replaces it for its block:
its own DRBG, clock, global ``random`` state, ``uuid1`` node and timestamp
guard, and temporary names. When it ends, the outer one resumes exactly where
it was, as if the inner block had not run. Every open operation belongs to one
thread; opening one on another thread while one is open is refused
(``ConcurrentOperation``).

Outside every operation, entropy is the system's and the clock is real, which
the harness relies on (a fresh reference database's name, for instance).

``EPOCH`` is the commit time of the HQ pin, so HQ's date-gated behavior
follows the pins: read from ``/opt/hq-pin-time`` (``PROOF_HQ_PIN_TIME``),
which the image records at build time; else from ``git log`` in HQ's checkout
while it still holds its history and a ``git`` to read it; else the time
recorded here for the pin this module was written against, which is refused
for any other pin.

``PROOF_HQ_DETERMINISM=0`` turns the seeding and the frozen clock off, for
comparing the lane with determinism on and off: every draw is the system's
(the editors' CSRF strings included) and the clock is real. Nothing else
changes, so the lane runs the same way in
both: an operation is still opened, nested, closed in order and refused on a
second thread, and ``proof.hq.boot.prepare_for_fork`` still refuses to fork
inside one.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import operator
import os
import random
import subprocess
import tempfile
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from proof.hq.boot import HarnessRefusal

ENABLED = os.environ.get("PROOF_HQ_DETERMINISM", "1") != "0"

HQ_ROOT = Path(os.environ.get("PROOF_HQ", "/opt/hq"))
PIN_TIME_FILE = Path(os.environ.get("PROOF_HQ_PIN_TIME", "/opt/hq-pin-time"))
PINS_FILE = Path(__file__).resolve().parent.parent / "pins.json"

# The committer time of commcare-hq f57e85e02913 (`git log -1 --format=%cI`),
# used only while HQ's checkout has no history and the image recorded no time.
_RECORDED_PIN = "f57e85e029130ceb576ea6d0f389b744509de6c9"
_RECORDED_PIN_TIME = "2026-09-25T23:11:53+01:00"


class ConcurrentOperation(HarnessRefusal):
    """An operation was opened on one thread while another thread held one open."""


def _parse_time(text: str, source: str) -> dt.datetime:
    try:
        moment = dt.datetime.fromisoformat(text.strip())
    except ValueError:
        raise RuntimeError(
            f"The proof harness read HQ's pin time from {source} and found {text.strip()!r}, which is not an "
            "ISO 8601 time. The image records it with `git -C /opt/hq log -1 --format=%cI`."
        ) from None
    if moment.tzinfo is None:
        raise RuntimeError(f"The proof harness read HQ's pin time from {source} without a UTC offset: {text!r}.")
    return moment.astimezone(dt.UTC)


def _pinned_hq_commit() -> str | None:
    try:
        return json.loads(PINS_FILE.read_text())["commcare-hq"]["commit"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _resolve_epoch() -> tuple[dt.datetime, str]:
    if PIN_TIME_FILE.is_file():
        return _parse_time(PIN_TIME_FILE.read_text(), str(PIN_TIME_FILE)), str(PIN_TIME_FILE)
    if (HQ_ROOT / ".git").exists():
        try:
            result = subprocess.run(
                ["git", "-C", str(HQ_ROOT), "log", "-1", "--format=%cI"],
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError:
            # No git to read the history with (the image's schema stage installs none).
            result = None
        if result is not None and result.returncode == 0 and result.stdout.strip():
            return _parse_time(result.stdout, f"git log in {HQ_ROOT}"), f"git log in {HQ_ROOT}"
    pinned = _pinned_hq_commit()
    if pinned != _RECORDED_PIN:
        raise RuntimeError(
            f"The proof harness needs the commit time of HQ's pin ({pinned or 'unknown'}) as the clock HQ's "
            f"operations see, and found neither {PIN_TIME_FILE} nor HQ's git history at {HQ_ROOT} (with a git to "
            "read it). The time "
            f"recorded in proof/hq/determinism.py is for {_RECORDED_PIN} only. Build the image so it writes "
            "/opt/hq-pin-time (proof/image/Dockerfile)."
        )
    return _parse_time(_RECORDED_PIN_TIME, "proof/hq/determinism.py"), f"recorded for HQ {_RECORDED_PIN[:12]}"


EPOCH, EPOCH_SOURCE = _resolve_epoch()


class HmacDrbg:
    """NIST SP 800-90A HMAC_DRBG over SHA-256, instantiated with ``seed`` and never reseeded."""

    def __init__(self, seed: bytes):
        self._key = b"\x00" * 32
        self._value = b"\x01" * 32
        self._update(bytes(seed))

    def _hmac(self, data: bytes) -> bytes:
        return hmac.new(self._key, data, hashlib.sha256).digest()

    def _update(self, provided: bytes = b"") -> None:
        self._key = self._hmac(self._value + b"\x00" + provided)
        self._value = self._hmac(self._value)
        if provided:
            self._key = self._hmac(self._value + b"\x01" + provided)
            self._value = self._hmac(self._value)

    def generate(self, size: int) -> bytes:
        out = bytearray()
        while len(out) < size:
            self._value = self._hmac(self._value)
            out += self._value
        self._update()
        return bytes(out[:size])


@dataclass
class _Scope:
    owner: int
    # None when PROOF_HQ_DETERMINISM=0: the operation is open, and draws nothing from it.
    drbg: HmacDrbg | None
    node: int | None = None


# The open operations, innermost last; all belong to one thread.
_STACK: list[_Scope] = []
_LOCK = threading.Lock()
_INSTALLED = False
_SYSTEM_URANDOM = os.urandom
_SYSTEM_GETNODE = uuid.getnode


def _current() -> _Scope | None:
    """The innermost operation, when it is open on this thread and seeds its draws."""
    if _STACK:
        scope = _STACK[-1]
        if scope.owner == threading.get_ident() and scope.drbg is not None:
            return scope
    return None


# How many draws ``_urandom`` and ``_getnode`` have answered in this process, seeded or not (``entropy_mark``).
_DRAWS = [0]


def entropy_mark():
    """Where every entropy source a computation could draw from stands: the draws answered so far, the global
    ``random`` state, ``tempfile``'s name sequence and ``uuid1``'s timestamp guard. Equal marks before and after
    a computation mean it drew nothing, so leaving it out moves no later draw."""
    sequence = getattr(tempfile, "_name_sequence", None)
    rng = getattr(sequence, "_rng", None) if sequence is not None else None
    return (
        _DRAWS[0],
        random.getstate(),
        None if rng is None else rng.getstate(),
        getattr(uuid, "_last_timestamp", None),
    )


def _urandom(size, /):
    _DRAWS[0] += 1
    scope = _current()
    if scope is None:
        return _SYSTEM_URANDOM(size)
    count = operator.index(size)
    if count < 0:
        raise ValueError("negative argument not allowed")
    return scope.drbg.generate(count)


def _getnode():
    _DRAWS[0] += 1
    scope = _current()
    if scope is None:
        return _SYSTEM_GETNODE()
    if scope.node is None:
        # As uuid._random_getnode: 48 random bits with the multicast bit set.
        scope.node = int.from_bytes(scope.drbg.generate(6)) | (1 << 40)
    return scope.node


def install() -> None:
    """Route every entropy reader through the open operation, if any; idempotent.

    ``proof.hq.boot.boot()`` calls it before HQ is imported, so a module that
    binds ``os.urandom`` by name binds the routed reader.
    """
    global _INSTALLED
    with _LOCK:
        if _INSTALLED:
            return
        os.urandom = _urandom
        random._urandom = _urandom
        uuid.getnode = _getnode
        _INSTALLED = True


def installed() -> bool:
    return _INSTALLED


@contextmanager
def operation(key: bytes, depth: int):
    """Run the block as one HQ operation: entropy seeded by ``key``, the clock frozen at ``EPOCH`` + ``depth`` s."""
    if not isinstance(key, (bytes, bytearray)) or not key:
        raise TypeError(f"An operation's key is the non-empty bytes of its state key; this one is {key!r}.")
    if isinstance(depth, bool) or not isinstance(depth, int) or depth < 0:
        raise ValueError(f"An operation's depth counts the writes before it, from 0; this one is {depth!r}.")
    install()
    thread = threading.get_ident()
    with _LOCK:
        if _STACK and _STACK[-1].owner != thread:
            raise ConcurrentOperation(
                "An HQ operation was opened on one thread while another thread held one open. HQ's clock, its "
                "global random state and uuid1's guard belong to the whole process, so two threads' operations "
                "would read each other's; run HQ operations on one thread."
            )
        scope = _Scope(owner=thread, drbg=HmacDrbg(bytes(key)) if ENABLED else None)
        outside = (random.getstate(), uuid._last_timestamp, tempfile._name_sequence) if scope.drbg is not None else None
        _STACK.append(scope)
    try:
        if scope.drbg is None:
            yield
        else:
            import time_machine

            random.seed(scope.drbg.generate(32))
            uuid._last_timestamp = None
            names = tempfile._RandomNameSequence()
            names._rng = random.Random(scope.drbg.generate(32))
            names._rng_pid = os.getpid()
            tempfile._name_sequence = names
            with time_machine.travel(EPOCH + dt.timedelta(seconds=depth), tick=False):
                yield
    finally:
        with _LOCK:
            if not _STACK or _STACK[-1] is not scope:
                raise RuntimeError("HQ operations closed out of order; each must close inside the one it opened in.")
            _STACK.pop()
            if outside is not None:
                random.setstate(outside[0])
                uuid._last_timestamp = outside[1]
                tempfile._name_sequence = outside[2]
