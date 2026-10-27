"""Where CommCare Android takes a worker: the reader's ``nav`` request (``src/.../Nav.java``).

``nav`` installs ``archive`` on a device whose network is HQ's own views over the served state, signs the
worker HQ made in, and reads each navigation as one session of the app's own home activity:

- ``commands``: each form's command set on a new session, the form completed and home handed its result, and
  each screen home then starts;
- ``paths``: lists of menu item ids, chosen from the app's first menu as a worker taps them, a list on the way
  answered with its first case;
- ``endpoints``: ``{id, arguments?, complete?}``, each launched as CommCare's own launcher sends it
  (``CommCareLauncher.launchCommCareForAppId``) and followed through Android's dispatcher to its home
  activity, a form it opens left as it opened, or completed where ``complete`` says so.

The answer holds one record a navigation under ``navs``, keyed ``command:<id>``, ``path:<ids joined by />``
or ``endpoint:<id>``: a command's and a path's ``steps``, and an endpoint's ``dispatched`` chain,
``handedHome`` and ``landed.steps`` (``proof/android/README.md``, the ``nav`` request). This module holds no
test; ``test_navigation.py`` asserts what the device does.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence


def nav(
    served,
    blobs,
    *,
    label: str,
    archive: bytes,
    commands: Iterable[str] = (),
    paths: Iterable[Sequence[str]] = (),
    endpoints: Iterable[Mapping] = (),
    device: str = "phone",
    sent: list | None = None,
) -> dict:
    """The ``nav`` request on ``archive`` over the served state, sent as the ``app`` request is
    (``proof.android.observe._read``), with the lane's answer table: the record ``_read`` makes, whose
    ``answer`` blob holds the device's answer; ``sent``, a list each form the device sent HQ is added to."""
    from proof.android import observe

    options = {
        "answers": observe._answers(),
        "device": device,
        "commands": list(commands),
        "paths": [list(path) for path in paths],
        "endpoints": [dict(endpoint) for endpoint in endpoints],
    }
    return observe._read(served, blobs, label, "nav", {"archive": archive}, options, sent=sent)
