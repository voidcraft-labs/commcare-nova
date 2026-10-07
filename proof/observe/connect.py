"""A Connect app's forms forwarded to CommCare Connect, as records (``proof/README.md``, "Connect in the unit").

Connect is the last reader of a Connect app: a worker submits a form to HQ,
HQ's Connect repeater forwards it, and Connect's receiver turns it into a
completed module, a visit, pay and a completed task for an opportunity a
manager made from the app's build. Where a document's app holds Connect
blocks (``is_connect``), its unit observes that whole chain for every state
it serves (``proof.observe.served``), each link its owner's code at the pins:

- **The opportunity** (``Opportunity``) is made once, while A is served, as
  a manager makes one: Connect downloads the released build from HQ's own
  archive view and reads its learn modules, deliver units and tasks
  (``opportunity/tasks.py::sync_learn_modules_and_deliver_units``,
  ``app_xml.py::get_task_units_for_app``); every deliver unit is paid for,
  the worker's claim is made, GPS verification is on, and one task of each
  type is assigned. Connect is a served process of its own
  (``proof.connect.runtime.ConnectSession``), and its database as the
  opportunity stood then is kept (``ready``). Every later state of the
  document is received by that opportunity, as an app republished, edited or
  saved in HQ goes on being received by the opportunity made before.
- **Each state forwards** (``forwarded``): the project space holds a Connect
  repeater (``proof.connect.hq.forwarding``), so whatever HQ's receiver
  takes, HQ's own repeater posts to Connect over a real connection, with a
  token it asked Connect for.
- **Formplayer's submissions** are the ones its walk of the state makes
  (``proof.formplayer.walk``), each received by HQ's receiver view as
  before; **Core's** are the ones its sessions made on the state's build
  (``proof.observe.sessions``), each posted to HQ's receiver view as a
  device posts one: to the address the build's profile names
  (``proof.connect.hq.post_path``), with the worker's own credentials. Nova's
  local archive names no address, so its submissions go to the project
  space's receiver with no app named (``core``), and once more under the
  app's id (``core@app``), which is how the lane shows what Connect would
  make of them if they named their app.
- **Each run is one worker's**: it meets HQ as the unit's fork leaves it and
  Connect as the opportunity stood (``Forwarder.begin`` goes back to
  ``ready``), so no run reads what another's submission left in either.
  After it, Connect's queued tasks are run (``collect``), and the run is
  kept: what HQ's receiver answered the device, what HQ kept of each forward
  (``proof.connect.hq.forwards``), each payload as it reached Connect with
  Connect's answer, each task Connect ran, and the rows Connect then holds.

What stands in for a person or a machine the lane does not have, each named
where it is done: the opportunity's rows (``proof/connect/driver.py``), and a
device's location fix, which only CommCare Android writes
(``PollSensorAction``): a device's submission has ``FIX`` written into its
meta's location node where the form holds one
(``proof.connect.hq.with_fix``), so HQ's build's carries a location and the
local archive's, which holds no node, carries none. Formplayer's submissions
are as Formplayer made them (no browser gave it a location).

A state's record is one blob: ``{"runs": {<reader>: [<run>...]}}``, each run
named by what it ran (a walk's run by its script's digest, a device's by its
place in Core's trace), so two states' runs pair by name. Every id
Formplayer or Core drew is marked (``proof.formplayer.canonical``), and the
app's and the build's ids are written ``@app`` and ``@build``, so the same
inputs give the same bytes.
"""

from __future__ import annotations

import hashlib
import io
import zipfile
from contextlib import contextmanager
from urllib.parse import urlsplit

CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn"
# The address Connect knows its HQ server by. Nothing is reached there: each request Connect makes of it is
# answered by HQ's own view over the unit's state (``Opportunity.answer``).
HQ_URL = "https://www.commcarehq.org"
# The fix a device writes (latitude, longitude, altitude, accuracy), for each submission Core made.
FIX = "12.97160 77.59460 920.0 5.0"
# What an opportunity's manager sets its learn app to pass at; the Core runner answers a score above it.
PASSING_SCORE = 5
RECEIVER = "/api/receiver/"
APP, BUILD, USERCASE, CONNECT = "@app", "@build", "@usercase", "@connect"
CATALOG = ("learnModules", "deliverUnits", "taskTypes")


def is_connect(files) -> bool:
    """Whether an app's build holds a Connect block: an element of Connect's namespace in one of its forms."""
    from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml

    marker = CONNECT_XMLNS.encode()
    for name, content in sorted((files or {}).items()):
        if not name.endswith(".xml") or marker not in content:
            continue
        try:
            root = parse_xml(content)
        except XmlNotWellFormed:
            continue
        if any(
            isinstance(element.tag, str) and element.tag.startswith(f"{{{CONNECT_XMLNS}}}") for element in root.iter()
        ):
            return True
    return False


def _views(served):
    """HQ's views for what Connect and a device ask of it: an answerer of its own, so what Formplayer asked
    while it walked the state stays Formplayer's record."""
    from proof.formplayer.hq import HqViews

    return HqViews(served.unit, served.username)


class Opportunity:
    """One opportunity in a served Connect, made from A's release, for the life of a document's unit."""

    def __init__(self, session):
        self.session = session
        self.views = None
        self.ready = None
        self.catalog = None
        self.asked = []
        # Whether Connect's database has moved from ``ready`` since it was last put back.
        self.moved = False

    def answer(self, method, url, headers, body):
        """HQ's own answer to one request Connect makes of its HQ server, by the view HQ's URLconf names."""
        from proof.formplayer.client import HqRequest

        if self.views is None:
            raise AssertionError(f"Connect asked HQ for {method} {url} while no state of the app is served.")
        address = urlsplit(url)
        request = HqRequest(method, address.path, address.query, tuple((name, value) for name, value in headers), body)
        answer = self.views(request)
        asked = self.views.exchanges[-1]
        self.asked.append({"view": asked.url_name, "method": method, "status": answer.status})
        return answer.status, answer.headers, answer.body

    def put_back(self):
        if self.moved:
            self.session.restore(self.ready)
            self.moved = False

    def close(self):
        self.session.close()


def open_opportunity(served, *, runtime=None) -> Opportunity:
    """The opportunity made while ``served`` (A's release) is what HQ serves: Connect's own sync of the build HQ
    released, then what a manager and the worker do before the first form arrives (the module's first point).
    The caller closes it."""
    from proof.connect import hq as connect_hq
    from proof.observe import services

    runtime = runtime or services.connect()
    holder = {}
    session = runtime.session(lambda *asked: holder["opportunity"].answer(*asked))
    opportunity = holder["opportunity"] = Opportunity(session)
    try:
        opportunity.views = _views(served)
        opportunity.views.begin(b"connect|opportunity", None)
        session.step(
            "opportunity",
            hqUrl=HQ_URL,
            domain=served.domain,
            learnApp=served.app_id,
            deliverApp=served.app_id,
            commcareUsername=served.username,
            passingScore=PASSING_SCORE,
            oauthClient=connect_hq.OAUTH_CLIENT,
        )
        session.step("sync")
        session.step("pay", name="Visits", deliverUnits="all")
        session.step("claim")
        session.step("flags", gps=True)
        session.step("assign_task", slug="all")
        state = session.step("collect")["state"]
        opportunity.catalog = {name: state[name] for name in CATALOG}
        opportunity.ready = session.checkpoint()
        opportunity.views = None
    except BaseException:
        opportunity.close()
        raise
    return opportunity


def opportunity_record(opportunity) -> dict:
    """The opportunity as its record holds it: what Connect asked HQ making it, and what it read of the app."""
    return {"asked": opportunity.asked, "catalog": opportunity.catalog}


class Forwarder:
    """One served state forwarding to the opportunity: each run's forwards, and Core's submissions posted."""

    def __init__(self, served, opportunity):
        self.served, self.opportunity = served, opportunity
        self.views = _views(served)
        self.runs: dict = {}
        self._reader = None
        self._received = []
        self._exchanges = 0
        self._name = None

    # A run of the served state (``proof.formplayer.hq.Served.run``) -------------------------------------------

    def begin(self, label: bytes):
        self.views.begin(b"connect|" + label, None)
        self.opportunity.views = self.views
        self.opportunity.put_back()
        self._received = []
        self._exchanges = len(self.served.hq.exchanges)

    def end(self, label: bytes):
        from proof.connect import hq as connect_hq
        from proof.formplayer.hq import RECEIVERS

        collected = self.opportunity.session.step("collect")
        if collected["exchanges"] or collected["tasks"]:
            self.opportunity.moved = True
        forwards = connect_hq.forwards(self.served.unit)
        self.opportunity.views = None
        # What HQ's receiver answered Formplayer in this run, where the run was a walk's.
        received = self._received + [
            {"status": asked.status}
            for asked in self.served.hq.exchanges[self._exchanges :]
            if asked.url_name in RECEIVERS
        ]
        posts = [exchange for exchange in collected["exchanges"] if exchange["path"] == RECEIVER]
        if self._reader is None or not (posts or forwards or received):
            return
        name = self._name or hashlib.sha256(label).hexdigest()[:16]
        self.runs.setdefault(self._reader, []).append(
            {
                "run": name,
                "received": received,
                "forwards": forwards,
                "posts": [
                    {
                        "payload": post.get("payload"),
                        "status": post["status"],
                        "body": post.get("body"),
                        "raised": post.get("raised") or [],
                    }
                    for post in posts
                ],
                "tasks": collected["tasks"],
                "state": collected["state"],
            }
        )

    def walked(self, trace, reader: str = "formplayer"):
        """Name each run kept of a walk by its place in the walk's trace (``walk-<n>``): a walk's runs are named
        by what each ran, and a derived run and its replay are told what to run in two ways, so the place a run
        holds among the trace's runs is what two states' walks share."""
        kept = self.runs.get(reader) or []
        submitted = [
            index
            for index, run in enumerate((trace or {}).get("runs") or [])
            if any(isinstance(step, dict) and step.get("submissions") for step in run.get("steps") or [])
        ]
        if len(kept) != len(submitted):
            raise AssertionError(
                f"Formplayer's walk made a submission in {len(submitted)} of its runs, and HQ's receiver was"
                f" reached in {len(kept)} runs of it. The two are read from the walk's trace and from HQ's own"
                " exchanges (proof.observe.connect.Forwarder); look at which run reached the receiver without"
                " the walk keeping its submission."
            )
        for run, index in zip(kept, submitted, strict=True):
            run["run"] = f"walk-{index}"

    @contextmanager
    def reading(self, reader: str):
        """Inside the block, each run that reaches HQ's receiver is kept as ``reader``'s."""
        held, self._reader = self._reader, reader
        try:
            yield self
        finally:
            self._reader = held

    # Core's submissions -----------------------------------------------------------------------------------------

    def devices(self, trace, *, path: str, reader: str = "core", fix: str | None = FIX):
        """Each submission of Core's ``trace`` posted to HQ's receiver at ``path`` as a device posts one, a run
        of the served state each; with ``fix`` written where the form holds a location node."""
        from proof.connect import hq as connect_hq
        from proof.formplayer.hq import PASSWORD
        from proof.observe.runs import submission_of
        from proof.observe.sessions import unmarked_submission

        with self.reading(reader):
            for index, run in enumerate((trace or {}).get("runs") or []):
                if submission_of(run) is None:
                    continue
                submission, _ = unmarked_submission(run)
                if fix is not None:
                    submission = connect_hq.with_fix(submission, fix)
                self._name = f"core-{index}"
                try:
                    with self.served.run(f"{reader}-{index}"):
                        request = connect_hq.device_request(path, self.served.username, PASSWORD, submission)
                        answer = self.views(request)
                        received = {"status": answer.status}
                        if answer.status >= 400:
                            received["said"] = answer.body[:300].decode("utf-8", "replace")
                        self._received.append(received)
                finally:
                    self._name = None

    # The record -----------------------------------------------------------------------------------------------

    def take(self, blobs, *, archives=()):
        """What was kept since the last ``take``, as a blob (the module's last paragraph); None where no run
        reached HQ's receiver."""
        from proof.formplayer import canonical

        runs, self.runs = self.runs, {}
        if not runs:
            return None
        served = self.served
        # Where Connect answers is this process's own address, which names nothing of the app.
        drawn = {served.app_id: APP, served.build_id: BUILD, self.opportunity.session.url: CONNECT}
        if served.usercase_id:
            drawn[served.usercase_id] = USERCASE
        given = canonical.given_ids(served.hq.restores, [served.archive(), *archives])
        value, _ = canonical.mark(canonical.replace_text({"runs": runs}, drawn), given)
        return blobs.put_json(value)


@contextmanager
def forwarded(served, opportunity, label: str):
    """While the block runs, the served state forwards what HQ receives to the opportunity's Connect; the
    block's value is the ``Forwarder``, or None where the document has no opportunity (no Connect app)."""
    if opportunity is None:
        yield None
        return
    from proof.connect import hq as connect_hq

    with connect_hq.forwarding(served.unit, opportunity.session.url, served.operation, label):
        forwarder = Forwarder(served, opportunity)
        served.forwarding = forwarder
        try:
            yield forwarder
        finally:
            served.forwarding = None
            opportunity.views = None


def release_post_path(served) -> str:
    """Where a device posts a form of the served state's released build: its profile's ``PostURL``."""
    from proof.connect import hq as connect_hq

    with zipfile.ZipFile(io.BytesIO(served.archive())) as archive:
        profile = archive.read("profile.ccpr") if "profile.ccpr" in archive.namelist() else None
    return connect_hq.post_path(profile, served.domain)


def local_post_path(document, served) -> str:
    """Where a device posts a form of Nova's local archive of the document: its profile's ``PostURL``, or the
    project space's receiver with no app named, since the archive names none."""
    from proof.connect import hq as connect_hq

    with zipfile.ZipFile(document.local_ccz) as archive:
        profile = archive.read("profile.ccpr") if "profile.ccpr" in archive.namelist() else None
    return connect_hq.post_path(profile, served.domain)


@contextmanager
def reading(forwarder, reader: str):
    """``Forwarder.reading`` where the state forwards (``forwarder`` is one), and nothing where it does not."""
    if forwarder is None:
        yield
        return
    with forwarder.reading(reader):
        yield


class Holder:
    """A unit's opportunity, where its document is a Connect app: opened while A is served, closed with the unit."""

    def __init__(self):
        self.opportunity = None

    def close(self):
        opportunity, self.opportunity = self.opportunity, None
        if opportunity is not None:
            opportunity.close()


def core_sessions(core_runner, files, restore):
    """Core's sessions on a build's files over ``restore``, derived as proof 3 derives them
    (``proof.observe.sessions``): the trace, or None where Core does not admit the build."""
    import tempfile
    from pathlib import Path

    from proof.observe.build import arrange
    from proof.observe.sessions import run_sessions

    with tempfile.TemporaryDirectory(prefix="proof-observe-connect-") as scratch:
        return run_sessions(core_runner, "A", arrange(files, Path(scratch, "A")), restore).trace
