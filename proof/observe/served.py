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

Each reader reads a state only where the state's app declares the platform
it runs the app on (``proof.lane.readers.PLATFORM_OF``, ``Served.platforms``):
the client an app that declares Web Apps, a device one that declares
Android. Formplayer's walk runs for every app, the serving every other
reader relies on, and models the client only where the app declares Web
Apps (``proof.formplayer.walk.Walk.web_apps``).

Each served state is one fork of the unit, and each run of a walk a fork
inside it, so nothing a submission leaves in HQ is there for the next run or
the next state. Every HQ step is an operation or a request of the unit, the
hook's own (``proof.observe.unit.HookUnit``), so what HQ notes in one is
recorded with the part and held by the check that judges it.
"""

from __future__ import annotations

import contextvars
import hashlib
from contextlib import contextmanager

from proof.observe.record import canonical
from proof.observe.runs import unbuildable

# The hook's name, which the unit logs its operations and requests under.
HOOK = "served"
# The served reader whose work runs now (``reading``): every request the hook's unit answers inside it is that
# reader's (``proof.observe.unit.HookUnit.request``), and what HQ notes answering it is reported under the reader's
# name (``proof.checks.observations.soft_assertion_differences``), so a run without that reader expects none of it.
# A state is served along Formplayer's walk, which every reader brings, so serving it is Formplayer's.
_READING: contextvars.ContextVar[str | None] = contextvars.ContextVar("proof_served_reader", default=None)


@contextmanager
def reading(reader: str):
    """Inside the block, every request the unit answers is ``reader``'s (``formplayer``, ``webapps``,
    ``android`` or ``connect``, ``proof.lane.readers.READERS``)."""
    token = _READING.set(reader)
    try:
        yield
    finally:
        _READING.reset(token)


def reader_now() -> str | None:
    """The served reader whose request the unit answers now, or None outside every reader's work."""
    return _READING.get()


# What HQ's Web Apps page hands the client of an app (``cloudcare/utils.py::format_app_doc``), but the two ids:
# each build has its own, and the client shows neither.
CLIENT_KEYS = ("langs", "multimedia_map", "name", "profile", "upstream_app_id", "imageUri")


def inputs(document, state):
    """What the served observation reads beyond its part's own inputs: the browser's code, for the client's
    screens (the image holds Formplayer and the rest), and the readers the run hands its states to
    (``proof.lane.readers``), so a record of one set of readers is never read for another."""
    from proof.lane import readers
    from proof.observe.browser import browser_fingerprint

    return {"browser": browser_fingerprint(), "readers": readers.canonical(readers.named())}


def observes(reader) -> bool:
    """Whether the run hands its served states to ``reader`` (``proof.lane.readers.named``)."""
    from proof.lane import readers

    return reader in readers.named()


def observes_state(reader, served) -> bool:
    """Whether the run hands ``served`` to ``reader`` and its app declares the platform ``reader`` runs it on
    (``proof.lane.readers.PLATFORM_OF``)."""
    return observes(reader) and served.reads(reader)


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
        """Formplayer's walk of the state: replayed where ``script`` is given, else derived, with the places the
        client's map gives its location questions where the observation shows the client (it was given a driver,
        the run hands its states to the client, and the state's app declares Web Apps;
        ``proof.webapps.observe.derived_places``), so the walk submits what the client submits."""
        from proof.formplayer import observe

        places = None
        if script is None and self.driver is not None and observes_state("webapps", self.served):
            from proof.observe import services
            from proof.webapps import observe as webapps

            with reading("webapps"):
                places = webapps.derived_places(self.served, services.client_browser(), runner=self.runner)
        return observe.walked(self.served, self.runner, self.blobs, script=script, places=places)

    def local(self, document, script, configuration):
        from proof.formplayer import observe

        return observe.local(self.served, self.runner, self.blobs, document, script=script, configuration=configuration)

    def webapps(self, trace):
        """The client's screens on ``trace``'s walk, as a blob, shown in the client's own browser
        (``proof.observe.services.client_browser``); None where the observation was given no editor driver, which
        is how a caller says it wants no browser's work (as proof 4's saves need one), or where the state's app
        declares no Web Apps (``observes_state``)."""
        if self.driver is None or not observes_state("webapps", self.served):
            return None
        from proof.observe import services
        from proof.webapps import observe

        with reading("webapps"):
            return self.blobs.put_json(observe.shown(self.served, services.client_browser(), trace))

    def reads(self) -> str:
        return client_reads(self.served.doc)

    def android(self, label: str, archive: bytes | None = None, *, delivered: bool = False, device: str = "phone"):
        """What a worker's device makes of the state (``proof.android.observe.app``): the released build's
        archive, or ``archive`` (Nova's local export) installed, over HQ's views of the state; with
        ``delivered``, its requests made as the worker HQ made and its restore and forms delivered to HQ's own
        addresses for the worker and the app (``proof.android.hq``); on a phone, or a tablet held in landscape
        (``device``)."""
        from proof.android import observe as android

        archive = android.release_archive(self.served) if archive is None else archive
        with reading("android"):
            return android.app(
                self.served, self.blobs, label=f"{label}:{device}", archive=archive, delivered=delivered, device=device
            )

    def devices_on(self, label: str, archive: bytes | None = None, *, delivered: bool = False) -> dict:
        """What a phone and a tablet each make of the state (``android``), under the keys a state's record keeps
        them by: ``android`` and ``androidTablet``, with ``delivered``'s prefix; none where the state's app declares
        no Android (``observes_state``)."""
        if not observes_state("android", self.served):
            return {}
        key = "androidDelivered" if delivered else "android"
        return {
            key: self.android(label, archive, delivered=delivered),
            f"{key}Tablet": self.android(label, archive, delivered=delivered, device="tablet"),
        }

    def devices(self, label: str, first: bytes, second: bytes, *, incomplete: bool = True, delivered: bool = False):
        """Two archives of one app on a device, over HQ's views of the state: installed in turn, and one device
        updated from the first to the second with every form left incomplete before it (``proof.android
        .observe``); with ``delivered``, the updated device's requests made as the worker HQ made and its restore
        delivered to HQ's own address for the worker (``proof.android.hq``), as for archives that name no
        server."""
        from proof.android import observe as android

        with reading("android"):
            return {
                "installs": android.installs(
                    self.served, self.blobs, label=f"{label}:installs", first=first, second=second
                ),
                "update": android.update(
                    self.served,
                    self.blobs,
                    label=f"{label}:update",
                    before=first,
                    after=second,
                    incomplete=incomplete,
                    delivered=delivered,
                ),
            }

    def release_differs(self, files):
        from proof.formplayer import observe

        return observe.release_is_the_build(self.served, files)


def serving(unit, document, app_id, *, driver, blobs, label, previous=None, change=None, edit=False):
    """``proof.formplayer.hq.serve`` for the unit's state, as a ``Serving`` (a context manager's value). Serving it is
    Formplayer's work (``reading``), and each other reader's inside it is that reader's."""
    from proof.formplayer import hq

    @contextmanager
    def opened():
        runner = _runner()
        with (
            reading("formplayer"),
            hq.serve(
                unit,
                document,
                app_id,
                runner=runner,
                operation=unit.operation,
                label=label,
                previous=previous,
                change=change,
                edit=edit,
            ) as served,
        ):
            yield Serving(served, runner, driver, blobs)

    return opened()


def local_archive(path, app_id) -> bytes:
    """Nova's local archive at ``path`` as the deployment's archive names its app: the working app HQ holds, A, in
    place of the placeholder its capture named (``proof.hq.operations.with_runtime_app_id``). A control's pre-fix
    archive names no app and is read as it is."""
    from proof.hq.operations import with_runtime_app_id

    return with_runtime_app_id(path.read_bytes(), app_id)


def _devices(held, document, app_id, a_record, b_record, blobs) -> dict:
    """Two exports of one app on a device (``Serving.devices``): Nova's two local exports, where the document has
    both, each naming A (``local_archive``), and HQ's builds of A then B, where HQ released both. The device
    updated from one local export to the other is given the input the lane gives Core over them (``delivered``):
    a worker who signs in, as on the device whose walks proof 3 compares, so the forms they leave incomplete
    before the update are theirs to reopen after it, as on HQ's builds. (A control's pre-fix exports name no
    server, finding 59, so without that input its device would meet Android's own defaults.)"""
    from proof.android import observe as android

    found = {}
    if not observes_state("android", held.served):
        return found
    if document.local_ccz is not None:
        again = document.local_ccz.parent / "local-again.ccz"
        if again.is_file():
            found["local"] = held.devices(
                "local",
                local_archive(document.local_ccz, app_id),
                local_archive(again, app_id),
                delivered=True,
            )
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
            holder = getattr(ctx, "connect", None) if observes("connect") else None
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
    if not held_a.get("served") or "connect" not in held_a or holder.opportunity is not None or not observes("connect"):
        return
    with serving(unit, document, app_id, driver=None, blobs=blobs, label="A") as held:
        holder.opportunity = connect.open_opportunity(held.served)


def aligned(
    unit,
    *,
    document,
    configuration,
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
    """What the unit records with ``b_aligned``: the local archive's walk over HQ's state (the archive compiled for
    the project space the unit's configuration names, ``Document.local_ccz_for``), and, where the raw
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
                recorded["devices"] = _devices(held, document, app_id, a_record, b_record, blobs)
                # Nova hands a local archive only to an app that declares Android, so neither Formplayer's walk of
                # it nor a device on it runs for one that declares none.
                archive = document.local_ccz_for(configuration) if held.served.reads("android") else None
                if archive is not None:
                    local = local_archive(archive, app_id)
                    with connect_.reading(forwarder, "formplayer"):
                        local_side, local_trace = held.local(document, script, configuration)
                    # A device on Nova's local archive as Android meets it (its requests to the addresses its
                    # profile names; on a control's pre-fix archive, to Android's own defaults, finding 59), and one
                    # given the input the lane gives Core over that archive.
                    recorded["local"] = {
                        "formplayer": local_side,
                        **({"android": held.android("local", local)} if observes_state("android", held.served) else {}),
                        **held.devices_on("local:delivered", local, delivered=True),
                    }
                    if forwarder is not None:
                        forwarder.walked(local_trace)
                        kept = forwarder.take(blobs, archives=[local])
                        if kept is not None:
                            recorded["local"]["connect"] = kept
    except ReleaseRefused as error:
        recorded["refused"] = refused(error)["refused"]
    return recorded
