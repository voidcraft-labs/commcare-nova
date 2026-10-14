"""Which readers a lane run hands its served states to: ``PROOF_READERS``.

Standard library only: the queue builder and the gate read it with no image.

The served readers are Formplayer, the Web Apps client (``webapps``), a
worker's device (``android``) and CommCare Connect's own server (``connect``)
(``proof.observe.served``). ``PROOF_READERS`` names the ones a run observes:

- unset or ``all``: every reader, the lane's whole profile (the nightly's and
  the weekly's, which never set anything else, and ``npm run proof``'s by
  default);
- ``0``: none, the pull request lane's profile;
- a comma list of ``formplayer``, ``webapps``, ``android`` and ``connect``:
  those, for a person or an agent running one reader over a slice
  (``proof/README.md``, "Seeing a reader's verdict before a merge"). Every
  reader named brings Formplayer (``BRINGS``): the client replays Formplayer's
  walk, Connect receives the submissions it makes, and the served states a
  device is handed (B's, and proof 4's saves) are served along that walk.

Without a reader:

- the unit leaves its ``served`` hook out where no reader is named
  (``proof.observe.unit.hooks``), and otherwise the hook observes only the
  named readers (``proof.observe.served``), naming them in its parts' keys, so
  no record of one set is read for another;
- every test that starts a reader the run does not name is deselected: each is
  marked ``reader`` (``proof/conftest.py``: by the fixtures that start one,
  ``FIXTURES``, and by hand, with the readers it starts as the mark's
  arguments, where a test starts one itself), and the session's services
  refuse to start a reader the run does not name (``proof.observe.services``),
  so a test that starts one unmarked fails rather than running half;
- the queue builder queues no package whose every test starts a reader the
  run does not name (``PACKAGES``) and no control only those readers' entries
  name, and the gate leaves to the nightly exactly the register's entries
  whose artifacts the unnamed readers write
  (``proof.checks.registers.held_entries``), saying which;
- the evidence store keeps each set's records and judgments apart:
  ``PROOF_READERS`` is one of the variables every storage, document,
  transcript and package key names, written as the set it names
  (``proof.store.keys.environment``).

Formplayer's form validation, which HQ's own build asks for
(``proof.hq.seams.formplayer_validation``), is HQ's, not a reader's, and runs
in every profile.
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Mapping

VARIABLE = "PROOF_READERS"
READERS = ("formplayer", "webapps", "android", "connect")
EVERY = frozenset(READERS)
NONE: frozenset[str] = frozenset()
# What each reader brings: every served state is served along Formplayer's walk, which the client replays,
# whose submissions Connect receives, and along which B and proof 4's saves are served to a device.
BRINGS = {reader: ("formplayer",) for reader in READERS}
# The pytest marker of a test that starts a served reader (proof/pytest.ini): its arguments name the readers it
# starts, none for every one.
MARK = "reader"
# The session fixtures that start a served reader, with the readers each starts (and each brings). A test whose
# fixtures reach one (directly or through another fixture) starts those.
FIXTURES = {"formplayer_runner": frozenset({"formplayer"}), "connect_runtime": frozenset({"connect", "formplayer"})}
# The packages whose every test starts a served reader, with the readers they start: a run that names none of
# them collects nothing of the package, and the queue builder queues none of its groups then. The gate holds this
# to the lane's own collection both ways: a package named here that still collects an item is a group no queue
# accounts for, and one left out that collects none is a queued group of no item
# (``proof.checks.sharding.verify``).
PACKAGES = {"proof/connect": frozenset({"connect", "formplayer"})}


class ReadersError(ValueError):
    """A ``PROOF_READERS`` that names no set of readers."""


def with_brought(names: Iterable[str]) -> frozenset[str]:
    """``names`` with every reader each brings (``BRINGS``)."""
    found = set(names)
    for name in list(found):
        found.update(BRINGS.get(name, ()))
    return frozenset(found)


def parse(value: str | None) -> frozenset[str]:
    """The readers a ``PROOF_READERS`` value names (see the module's docstring), or ``ReadersError``."""
    text = (value or "").strip()
    if text in ("", "all"):
        return EVERY
    if text == "0":
        return NONE
    names = {name.strip() for name in text.split(",") if name.strip()}
    unknown = sorted(names - EVERY)
    if unknown or not names:
        raise ReadersError(
            f"{VARIABLE} is {value!r}, and it names the readers a run observes as all (or unset), 0 (none), or a"
            f" comma list of {', '.join(READERS)}; {', '.join(unknown) or 'nothing'} is none of them."
        )
    return with_brought(names)


def named(environ: Mapping[str, str] | None = None) -> frozenset[str]:
    """The readers the run observes (``PROOF_READERS`` of ``environ``, the process's by default)."""
    return parse((os.environ if environ is None else environ).get(VARIABLE))


def served(environ: Mapping[str, str] | None = None) -> bool:
    """Whether the run hands its served states to any reader."""
    return bool(named(environ))


def canonical(readers: Iterable[str]) -> str:
    """The set as the store's keys and a run's records write it: ``all``, ``0``, or the readers in order."""
    readers = frozenset(readers)
    if readers == EVERY:
        return "all"
    if not readers:
        return "0"
    return ",".join(name for name in READERS if name in readers)


def from_record(value) -> frozenset[str]:
    """The readers a queue's or a ``serve.json``'s ``readers`` names: absent or true for every one, false for
    none, or their list."""
    if value is None or value is True:
        return EVERY
    if value is False:
        return NONE
    if isinstance(value, list) and all(isinstance(name, str) for name in value):
        return parse(",".join(value)) if value else NONE
    raise ReadersError(f"A run's readers are true, false or a list of {', '.join(READERS)}; got {value!r}.")


def to_record(readers: Iterable[str]):
    """The readers as a queue and ``serve.json`` record them: true for every one, false for none, else their
    list (``from_record`` reads it back)."""
    readers = frozenset(readers)
    if readers == EVERY:
        return True
    if not readers:
        return False
    return [name for name in READERS if name in readers]


def profile(readers) -> str:
    """The timings profile a run's costs belong to: ``no-readers`` for none, ``readers`` for any (a slice of some
    readers is packed by the whole profile's measures, an overestimate)."""
    return "readers" if readers else "no-readers"


def described(readers: Iterable[str]) -> str:
    """The set as a sentence names it."""
    readers = frozenset(readers)
    if readers == EVERY:
        return "every reader"
    if not readers:
        return "no reader"
    return "only " + ", ".join(name for name in READERS if name in readers)
