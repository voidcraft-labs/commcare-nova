"""A document's app served to Formplayer and to the Web Apps client, as records (``proof/README.md``).

Where the unit runs Core's sessions over a state's build, it also serves
the state as HQ serves an app to Web Apps (``proof.formplayer.hq.serve``: a
worker, the document's cases, a released build, HQ's own views answering)
and keeps what its two readers make of it:

- **Formplayer's sessions** (``proof.formplayer.observe``): the walk derived
  on the baseline state and replayed on every other;
- **a worker's device** (``proof.android.observe``): the archive a worker
  installs of the state, read by CommCare Android's own code, the worker
  signing in and every walk down the app's menus, its network answered by
  HQ's own views over the state (each form it saves sent to HQ's receiver,
  each search to HQ's search view);
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

Where the document's app holds Connect blocks, each served state also
forwards what HQ receives to CommCare Connect, and what Connect then holds
is kept with it (``connect``, ``proof.observe.connect``): ``observe`` makes
the opportunity while A is served, and every later state is received by it.

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

    def android(self, label: str, archive: bytes | None = None, *, delivered: bool = False, device: str = "phone"):
        """What a worker's device makes of the state (``proof.android.observe.app``): the released build's
        archive, or ``archive`` (Nova's local export) installed, over HQ's views of the state; with
        ``delivered``, its restore and forms delivered to HQ's own addresses for the worker and the app
        (``proof.android.hq``); on a phone, or a tablet held in landscape (``device``)."""
        from proof.android import observe as android

        archive = android.release_archive(self.served) if archive is None else archive
        return android.app(
            self.served, self.blobs, label=f"{label}:{device}", archive=archive, delivered=delivered, device=device
        )

    def devices_on(self, label: str, archive: bytes | None = None, *, delivered: bool = False) -> dict:
        """What a phone and a tablet each make of the state (``android``), under the keys a state's record keeps
        them by: ``android`` and ``androidTablet``, with ``delivered``'s prefix."""
        key = "androidDelivered" if delivered else "android"
        return {
            key: self.android(label, archive, delivered=delivered),
            f"{key}Tablet": self.android(label, archive, delivered=delivered, device="tablet"),
        }

    def devices(self, label: str, first: bytes, second: bytes, *, incomplete: bool = True):
        """Two archives of one app on a device, over HQ's views of the state: installed in turn, and one device
        updated from the first to the second with every form left incomplete before it (``proof.android
        .observe``)."""
        from proof.android import observe as android

        return {
            "installs": android.installs(
                self.served, self.blobs, label=f"{label}:installs", first=first, second=second
            ),
            "update": android.update(
                self.served, self.blobs, label=f"{label}:update", before=first, after=second, incomplete=incomplete
            ),
        }

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


def _devices(held, document, a_record, b_record, blobs) -> dict:
    """Two exports of one app on a device (``Serving.devices``): Nova's two local exports, where the document has
    both, and HQ's builds of A then B, where HQ released both."""
    from proof.android import observe as android

    found = {}
    if document.local_ccz is not None:
        again = document.local_ccz.parent / "local-again.ccz"
        if again.is_file():
            found["local"] = held.devices("local", document.local_ccz.read_bytes(), again.read_bytes())
    a_state = (a_record or {}).get("state") or {}
    b_state = (b_record or {}).get("state") or {}
    if android.released(a_state.get("build")) and android.released(b_state.get("build")):
        first = android.stored_archive(a_state.get("archive"), blobs)
        second = android.stored_archive(b_state.get("archive"), blobs)
        if first is not None and second is not None:
            found["republish"] = held.devices("republish", first, second)
    return found


def refused(error) -> dict:
    """A state HQ releases no build of, as a record: what HQ raised making one, by its class."""
    return {"served": False, "refused": getattr(error, "raised", None) or "AppValidationError"}


def _state(serving_, side, trace, *, files=None, label=None):
    """One served state's record: Formplayer's side record, the client's screens on its walk, what the client
    reads of the app, whether the release is the build the other checks read, and, with ``label``, what a
    worker's device makes of the release."""
    recorded = {"formplayer": side, "clientReads": serving_.reads()}
    if label is not None:
        recorded.update(serving_.devices_on(label))
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
    from proof.observe import connect
    from proof.webapps.hq import ReleaseRefused

    try:
        with serving(ctx.unit, ctx.document, ctx.app_id, driver=ctx.editor_driver, blobs=ctx.blobs, label="A") as held:
            # A Connect app's opportunity is made here, from A's release, and receives every later state.
            holder = getattr(ctx, "connect", None)
            if holder is not None and holder.opportunity is None and connect.is_connect(ctx.build.files):
                holder.opportunity = connect.open_opportunity(held.served)
            opportunity = holder.opportunity if holder is not None else None
            with connect.forwarded(held.served, opportunity, "A") as forwarder:
                with connect.reading(forwarder, "formplayer"):
                    side, trace = held.formplayer()
                state = _state(held, side, trace, files=ctx.build.files, label="A")
                if forwarder is not None:
                    forwarder.walked(trace)
                    kept = forwarder.take(ctx.blobs)
                    if kept is not None:
                        state["connect"] = kept
            record = {"served": True, "runtime": formplayer.runtime(held.runner), "A": state}
            if opportunity is not None:
                record["connect"] = connect.opportunity_record(opportunity)
            return record
    except ReleaseRefused as error:
        # HQ's own make_build refuses the app (a build profile it cannot build, say), which the bar reports.
        return refused(error)


def reopen(unit, *, document, app_id, a_record, holder, blobs):
    """The opportunity of a Connect document whose ``a`` part the store held, made again as it was made: while A
    is served, from the release HQ's own view serves Connect. Nothing where A's record holds none."""
    from proof.observe import connect

    held_a = ((a_record or {}).get("hooks") or {}).get(HOOK) or {}
    if not held_a.get("served") or "connect" not in held_a or holder.opportunity is not None:
        return
    with serving(unit, document, app_id, driver=None, blobs=blobs, label="A") as held:
        holder.opportunity = connect.open_opportunity(held.served)


def aligned(
    unit,
    *,
    document,
    app_id,
    a_record,
    a_build,
    b_aligned,
    differs,
    change,
    previous,
    driver,
    blobs,
    connect=None,
    sessions=None,
    b_record=None,
):
    """What the unit records with ``b_aligned``: the local archive's walk over HQ's state, and, where the raw
    builds of A and of B aligned to A differ, that build's walk and the client's screens on it. None where A
    was not served (its hook did not run, or HQ releases no build of A).

    A worker's device is handed each of those states too, and two exports of one app in turn
    (``devices``): Nova's two local exports, and HQ's builds of A then B (``b_record`` the ``b`` part's record,
    whose state keeps B's archive), each installed in turn and one updated to the other.

    ``connect`` is the unit's opportunity holder (``proof.observe.connect.Holder``): for a Connect app, each
    state also forwards what HQ receives to the opportunity, Formplayer's submissions as its walk makes them
    and a device's as its walks send them. ``sessions`` is proof 3's sessions as the part records them."""
    from proof.formplayer.observe import script_of
    from proof.observe import connect as connect_

    held_a = ((a_record or {}).get("hooks") or {}).get(HOOK) or {}
    if not held_a.get("served"):
        return None
    script = script_of(blobs.get_json(held_a["A"]["formplayer"]["trace"]))
    walks_b = b_aligned is not None and b_aligned.files is not None and differs and unbuildable(b_aligned) is None
    from proof.webapps.hq import ReleaseRefused

    opportunity = connect.opportunity if connect is not None else None

    recorded = {}
    try:
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
            with connect_.forwarded(held.served, opportunity, "B" if walks_b else "local") as forwarder:
                if walks_b:
                    with connect_.reading(forwarder, "formplayer"):
                        side, trace = held.formplayer(script)
                    recorded["B"] = _state(held, side, trace, files=b_aligned.files, label="B")
                    if forwarder is not None:
                        forwarder.walked(trace)
                        kept = forwarder.take(blobs)
                        if kept is not None:
                            recorded["B"]["connect"] = kept
                recorded["devices"] = _devices(held, document, a_record, b_record, blobs)
                if document.local_ccz is not None:
                    with connect_.reading(forwarder, "formplayer"):
                        local_side, local_trace = held.local(document, script)
                    # A device on Nova's local archive as Android meets it (its requests to Android's own defaults,
                    # finding 59), and one given the input the lane gives Core over that archive.
                    recorded["local"] = {
                        "formplayer": local_side,
                        "android": held.android("local", document.local_ccz.read_bytes()),
                        **held.devices_on("local:delivered", document.local_ccz.read_bytes(), delivered=True),
                    }
                    if forwarder is not None:
                        forwarder.walked(local_trace)
                        kept = forwarder.take(blobs, archives=[document.local_ccz.read_bytes()])
                        if kept is not None:
                            recorded["local"]["connect"] = kept
    except ReleaseRefused as error:
        recorded["refused"] = refused(error)["refused"]
    return recorded
