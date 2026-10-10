"""HQ answering an Android device's network with its own views, over a state the unit serves.

A device the lane reads beside HQ's unit has a network (``proof.android.peer``): every request
commcare-android's own HTTP client makes, whatever address the app named, is answered here the way HQ's own
server answers it, by the view HQ's URLconf names for its path behind HQ's own middleware, over the served
state (``proof.formplayer.hq.HqViews``, the same handler Formplayer's requests reach). So the worker's sign-in
is HQ's own key record view and restore view, a form the device sends is taken whole by HQ's receiver (its
locks, its case processing, what it does once they commit, and the Connect forward behind it where the project
space has one), a search runs HQ's search view down to HQ's own Elasticsearch, and a claim makes the case HQ
makes. A request no view answers is HQ's 404. The host the app named is kept with each request, and never
changes which view answers: the lane's HQ is every server a device reaches.

Each device is a fork of the served state of its own (``DevicePeer`` enters it, ``close`` puts it back), so no
device reads what another left, as no state reads what another left. Its sessions meet HQ as the state stands
once the worker has signed in (``DevicePeer.control``): the device signs in at its fork's base, and each walk
it begins is a fork of that base that the next walk's beginning puts back, so nothing a walk sent HQ is there
for the next, as each run of Formplayer's walk is a fork. A device made again after a walk that changed it
(``base``) signs in again at the base.

Each request runs as a request of the unit keyed by its walk and its place in it, so HQ draws the same ids
for it on every run.

Nova's local archive names no server (finding 59), so a device on it makes its requests to Android's own
defaults (``R.string.ota_restore_url``, ``R.string.PostURL``, with the username as typed, no project space
named), and HQ's views answer them as they answer anything else. A second device on the same archive
(``delivered``) is given the input the lane gives Core over that archive: its restore is what HQ's own restore
view answers the worker, asked at the project space's restore address with the worker's own credentials, and
each form it sends is taken by HQ's receiver under the app's id, as the released build's profile addresses it.
Only the transport differs, which is what finding 59 names: the request the app wrote is kept as it wrote it,
the device reads HQ's answer as its own, and nothing of either is changed.
"""

from __future__ import annotations

from contextlib import ExitStack
from dataclasses import dataclass, field

# What the device's own messages ask (Peer.java).
RUN = "run"
BASE = "base"


@dataclass
class Exchange:
    """One request the device made and how HQ answered it; ``delivered`` the address it was delivered to, where
    it was not the one the app named."""

    walk: str
    method: str
    url: str
    url_name: str | None
    status: int
    raised: str | None = None
    delivered: str | None = None
    # What HQ said where it did not answer 2xx (the start of its body).
    said: str | None = None


def is_restore(request) -> bool:
    """Whether a device's request is its data pull's case fetch (``CommcareRequestGenerator.makeCaseFetchRequest``:
    a GET naming the device and asking for items), wherever the app addressed it."""
    from urllib.parse import parse_qs

    asked = parse_qs(request.query, keep_blank_values=True)
    return request.method == "GET" and asked.get("items") == ["true"] and "device_id" in asked


def is_submission(request) -> bool:
    """Whether a device's request sends a form (a multipart POST holding the form's instance), wherever the app
    addressed it."""
    from proof.formplayer.client import HqRequest
    from proof.formplayer.hq import multipart_parts

    if request.method != "POST" or "multipart/" not in (request.header("Content-Type") or ""):
        return False
    parts = multipart_parts(HqRequest(request.method, request.path, request.query, request.headers, request.body))
    return any(name == "xml_submission_file" for name, _ in parts)


@dataclass
class DevicePeer:
    """HQ, as one device of a served state reaches it (``proof.formplayer.hq.Served``)."""

    served: object
    label: str
    # Whether the device's restore and forms are delivered to HQ's own addresses for the worker and the app (the
    # module's last paragraph), for a device on an archive that names no server.
    delivered: bool = False
    # The kind of device (``Reader.device``): a phone or a tablet.
    device: str = "phone"
    exchanges: list = field(default_factory=list)
    _views: object = None
    _walk: object = None
    _stack: object = None
    _device: object = None
    _bases: int = 0

    def __post_init__(self):
        from proof.formplayer.hq import HqViews

        self._views = HqViews(self.served.unit, self.served.worker.username)
        self._device = ExitStack()
        self._device.enter_context(self.served.unit.fork())
        self._at_base()

    @property
    def views(self):
        """HQ's views as the device met them (each request, each submission, search and claim it kept)."""
        return self._views

    def _at_base(self) -> None:
        from proof.hq import redis as hq_redis

        hq_redis.flush()
        self._walk = None
        self._views.begin(f"android|{self.label}|base#{self._bases}".encode(), None)

    def control(self, what: str, name: str) -> None:
        """A message of the device's own: ``run`` begins the walk ``name`` in a fork of its own; ``base`` puts
        the last walk's fork back, where the device signs in again."""
        if what not in (RUN, BASE):
            raise ValueError(f"The Android device sent the harness a message it has no name for: {what!r}.")
        self._leave()
        if what == BASE:
            self._bases += 1
            self._at_base()
            return
        from proof.hq import redis as hq_redis

        stack = ExitStack()
        try:
            stack.enter_context(self.served.unit.fork())
            hq_redis.flush()
            self._views.begin(f"android|{self.label}|walk|{name}".encode(), None)
            forwarding = getattr(self.served, "forwarding", None)
            if forwarding is not None:
                # What HQ's receiver takes from the device in the walk is forwarded to Connect as the device's.
                label = f"android|{self.label}|{name}".encode()
                forwarding.begin(label, reader="android", views=self._views, name=self._run_name(name))
                stack.callback(forwarding.end, label)
        except BaseException:
            stack.close()
            raise
        self._stack, self._walk = stack, name

    def _run_name(self, walk: str) -> str:
        """A walk's run as Connect's record names it: the walk, with the kind of device where it is not a phone,
        so a phone's walk and a tablet's are two runs, each paired with the same device's walk of another
        state."""
        return walk if self.device == "phone" else f"{walk}@{self.device}"

    def _leave(self) -> None:
        stack, self._stack = self._stack, None
        if stack is not None:
            stack.close()

    def http(self, request):
        """HQ's answer to one request of the device's (``proof.android.peer.DeviceRequest``)."""
        from proof.formplayer.client import HqRequest

        path, headers, delivered = request.path, request.headers, None
        if self.delivered and (is_restore(request) or is_submission(request)):
            path, headers = self._delivery(request)
            delivered = path
        answer = self._views(HqRequest(request.method, path, request.query, headers, request.body))
        asked = self._views.exchanges[-1]
        self.exchanges.append(
            Exchange(
                walk=self._walk or f"base#{self._bases}",
                method=request.method,
                url=request.url,
                url_name=asked.url_name,
                status=answer.status,
                raised=asked.raised,
                delivered=delivered,
                said=asked.refusal[:300] if asked.refusal else None,
            )
        )
        return answer.status, answer.headers, answer.body

    def _delivery(self, request):
        """Where HQ takes the device's restore or form for the worker and the app, and with whose credentials:
        the project space's restore view (``ota_restore``), or the receiver the released build's profile
        addresses (its ``PostURL``), each as the worker HQ made, by their full username."""
        import base64
        import io
        import zipfile

        from django.urls import reverse

        from proof.android import observe
        from proof.connect import hq as connect_hq

        served = self.served
        if is_restore(request):
            path = reverse("ota_restore", args=[served.domain])
        else:
            with zipfile.ZipFile(io.BytesIO(served.archive())) as archive:
                profile = archive.read("profile.ccpr") if "profile.ccpr" in archive.namelist() else None
            path = connect_hq.post_path(profile, served.domain)
        worker = observe.worker(served)
        credentials = base64.b64encode(f"{served.worker.username}:{worker['password']}".encode()).decode()
        headers = tuple((name, value) for name, value in request.headers if name.lower() != "authorization")
        return path, (*headers, ("Authorization", f"Basic {credentials}"))

    def close(self) -> None:
        self._leave()
        device, self._device = self._device, None
        if device is not None:
            device.close()
        from proof.hq import redis as hq_redis

        hq_redis.flush()
        forwarding = getattr(self.served, "forwarding", None)
        if forwarding is not None:
            # The ids HQ's restores gave the device are HQ's and the app's, never the device's own.
            forwarding.restores.extend(self._views.restores)
