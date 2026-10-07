"""A document's app served to Formplayer and to the Web Apps client, as records (``proof/README.md``).

Where the unit runs Core's sessions over a state's build, it also serves
the state as HQ serves an app to Web Apps (``proof.formplayer.hq.serve``: a
worker, the document's cases, a released build, HQ's own views answering)
and keeps what its two readers make of it:

- **Formplayer's sessions** (``proof.formplayer.observe``): the walk derived
  on the baseline state and replayed on every other;
- **the Web Apps client's screens** (``proof.webapps.observe``), read in the
  editor driver's Chromium on the same walk: what only the client decides
  (a description it shows or not, a tile cell's place, alignment and size,
  the empty list's message, the home screen's tiles, a hidden column, where
  the client lands). The client reads Formplayer's answers and what HQ's
  page hands it of the app (``client_reads``), so it is observed for a
  state only where one of those is not its baseline's: a client given the
  same page and the same answers shows the same screens.

``observe(ctx)`` is the unit's hook at A (``proof.observe.unit.HOOKS``): A is
the baseline of proof 3's comparisons. ``aligned`` is what the unit records
with the ``b_aligned`` part: Nova's local archive walked over HQ's state
(``formplayer.local``), and B aligned to A walked and shown where its raw
build differs from A's, exactly where Core's sessions replay. Proof 4's own
observation (``proof.observe.proof4``) calls ``baseline`` at B and ``saved``
after each save, through the same functions.

Each served state is one fork of the unit, and each run of a walk a fork
inside it, so nothing a submission leaves in HQ is there for the next run or
the next state. Every HQ step is an operation or a request of the unit, the
hook's own (``proof.observe.unit.HookUnit``), so what HQ notes in one is
recorded with the part and held by the check that judges it.
"""

from __future__ import annotations

import hashlib

from proof.observe.record import canonical
from proof.observe.runs import unbuildable

# The hook's name, which the unit logs its operations and requests under.
HOOK = "served"
# What HQ's Web Apps page hands the client of an app (``cloudcare/utils.py::format_app_doc``), but the two ids:
# each build has its own, and the client shows neither.
CLIENT_KEYS = ("langs", "multimedia_map", "name", "profile", "upstream_app_id", "imageUri")


def inputs(document, state):
    """What the served observation reads beyond its part's own inputs: the browser's code, for the client's
    screens (the image holds Formplayer and the rest)."""
    from proof.observe.browser import browser_fingerprint

    return {"browser": browser_fingerprint()}


def client_reads(doc) -> str:
    """The digest of what HQ's Web Apps page hands the client of an app, read by HQ's own ``format_app_doc``."""
    from corehq.apps.cloudcare.utils import format_app_doc

    shown = format_app_doc(doc)
    return "sha256:" + hashlib.sha256(canonical({key: shown.get(key) for key in CLIENT_KEYS})).hexdigest()


def _runner():
    from proof.observe import services

    return services.formplayer()


class Serving:
    """One state served: Formplayer's walk of it, and the client's screens on that walk."""

    def __init__(self, served, runner, driver, blobs):
        self.served, self.runner, self.driver, self.blobs = served, runner, driver, blobs

    def formplayer(self, script=None):
        from proof.formplayer import observe

        return observe.walked(self.served, self.runner, self.blobs, script=script)

    def local(self, document, script):
        from proof.formplayer import observe

        return observe.local(self.served, self.runner, self.blobs, document, script=script)

    def webapps(self, trace):
        """The client's screens on ``trace``'s walk, as a blob, shown in the client's own browser
        (``proof.observe.services.client_browser``); None where the observation was given no editor driver, which
        is how a caller says it wants no browser's work (as proof 4's saves need one)."""
        if self.driver is None:
            return None
        from proof.observe import services
        from proof.webapps import observe

        return self.blobs.put_json(observe.shown(self.served, services.client_browser(), trace))

    def reads(self) -> str:
        return client_reads(self.served.doc)

    def release_differs(self, files):
        from proof.formplayer import observe

        return observe.release_is_the_build(self.served, files)


def serving(unit, document, app_id, *, driver, blobs, label, previous=None, change=None, edit=False):
    """``proof.formplayer.hq.serve`` for the unit's state, as a ``Serving`` (a context manager's value)."""
    from contextlib import contextmanager

    from proof.formplayer import hq

    @contextmanager
    def opened():
        runner = _runner()
        with hq.serve(
            unit,
            document,
            app_id,
            runner=runner,
            operation=unit.operation,
            label=label,
            previous=previous,
            change=change,
            edit=edit,
        ) as served:
            yield Serving(served, runner, driver, blobs)

    return opened()


def _state(serving_, side, trace, *, files=None):
    """One served state's record: Formplayer's side record, the client's screens on its walk, what the client
    reads of the app, and whether the release is the build the other checks read."""
    recorded = {"formplayer": side, "clientReads": serving_.reads()}
    shown = serving_.webapps(trace)
    if shown is not None:
        recorded["webapps"] = shown
    if files is not None:
        differs = serving_.release_differs(files)
        if differs is not None:
            recorded["releaseDiffers"] = differs
    return recorded


def observe(ctx):
    """The hook at A: A served, Formplayer's walk derived on it, and the client's screens on that walk."""
    from proof.formplayer import observe as formplayer

    if ctx.state != "A":
        return {}
    if unbuildable(ctx.build) is not None:
        # HQ releases no build of it (``Application.make_build`` raises), so nothing is served; the bar reports why.
        return {"served": False}
    with serving(ctx.unit, ctx.document, ctx.app_id, driver=ctx.editor_driver, blobs=ctx.blobs, label="A") as held:
        side, trace = held.formplayer()
        return {
            "served": True,
            "runtime": formplayer.runtime(held.runner),
            "A": _state(held, side, trace, files=ctx.build.files),
        }


def aligned(unit, *, document, app_id, a_record, a_build, b_aligned, differs, change, previous, driver, blobs):
    """What the unit records with ``b_aligned``: the local archive's walk over HQ's state, and, where the raw
    builds of A and of B aligned to A differ, that build's walk and the client's screens on it. None where A
    was not served (its hook did not run, or HQ releases no build of A)."""
    from proof.formplayer.observe import script_of

    held_a = ((a_record or {}).get("hooks") or {}).get(HOOK) or {}
    if not held_a.get("served"):
        return None
    script = script_of(blobs.get_json(held_a["A"]["formplayer"]["trace"]))
    walks_b = b_aligned is not None and b_aligned.files is not None and differs and unbuildable(b_aligned) is None
    recorded = {}
    with serving(
        unit,
        document,
        app_id,
        driver=driver,
        blobs=blobs,
        label="B" if walks_b else "local",
        previous=previous,
        change=change if walks_b else None,
    ) as held:
        if walks_b:
            side, trace = held.formplayer(script)
            recorded["B"] = _state(held, side, trace, files=b_aligned.files)
        if document.local_ccz is not None:
            recorded["local"] = {"formplayer": held.local(document, script)[0]}
    return recorded
