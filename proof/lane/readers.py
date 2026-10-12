"""Whether a lane run hands its served states to the readers: ``PROOF_READERS``, on unless set to ``0``.

Standard library only: the queue builder and the gate read it with no image.

The lane has two profiles. With the readers (the nightly's, and ``npm run
proof``'s by default) every state a unit serves is handed to Formplayer, the
Web Apps client, a device and, for a Connect app, Connect's own server
(``proof.observe.served``), and every test that starts one of them runs.
Without them (``PROOF_READERS=0``, the pull request lane's):

- the unit leaves its ``served`` hook out (``proof.observe.unit.hooks``), so
  no state is served and proof 4's saves are served to nothing;
- every test that starts a served reader is marked ``reader``
  (``proof/conftest.py``: by the fixtures that start one, ``FIXTURES``, and by
  hand where a test starts one itself) and deselected, and the session's
  services refuse to start one (``proof.observe.services``), so a test that
  starts a reader unmarked fails rather than running half;
- the queue builder queues no package whose every test starts a reader
  (``PACKAGES``) and no control only reader entries name, and the gate leaves
  the register's entries whose artifacts only the readers write to the
  nightly (``proof.checks.registers.served_entry``);
- the evidence store keeps the profile's records and judgments apart:
  ``PROOF_READERS`` is one of the variables every storage, document,
  transcript and package key names (``proof.store.keys.ENVIRONMENT_VARIABLES``).

Formplayer's form validation, which HQ's own build asks for
(``proof.hq.seams.formplayer_validation``), is HQ's, not a reader's, and runs
in both profiles.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

VARIABLE = "PROOF_READERS"
# The pytest marker of a test that starts a served reader (proof/pytest.ini).
MARK = "reader"
# The session fixtures that start a served reader: the session's Formplayer and Connect's runtime. A test whose
# fixtures reach either (directly or through another fixture) starts it.
FIXTURES = frozenset({"formplayer_runner", "connect_runtime"})
# The packages whose every test starts a served reader, which a run without them collects nothing of: the queue
# builder queues none of them then. The gate holds this to the lane's own collection both ways: a package named
# here that still collects an item is a group no queue accounts for, and one left out that collects none is a
# queued group of no item (``proof.checks.sharding.verify``).
PACKAGES = frozenset({"proof/connect"})


def served(environ: Mapping[str, str] | None = None) -> bool:
    """Whether the run hands its served states to the readers: ``PROOF_READERS`` unset or anything but ``0``."""
    return (os.environ if environ is None else environ).get(VARIABLE) != "0"


def profile(readers: bool) -> str:
    """The profile's name, as ``proof/timings.json`` and the gate name it."""
    return "readers" if readers else "no-readers"
