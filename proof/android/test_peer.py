"""The device's network: what a client sends through the reader's proxy reaches the harness as it was written.

Contract (``proof.android.peer``): every request a device's HTTP client makes through the proxy, a plain one
sent whole or an ``https`` one through a tunnel inside which the proxy speaks TLS with a certificate of its own
authority, reaches ``peer.http`` with the scheme, host, path, query, headers and body the client wrote; the
answer reaches the client with a ``Date`` the server's clock wrote where the answer had none; a message of the
device's own reaches ``peer.control``; and what answers the network refusing a request ends the request with
``PeerFailed`` after the device is answered. Plausible failures: a tunnel whose inner request is read as the
tunnel's (a lost path, a lost body), a body cut at a chunk, a certificate the client refuses, an answer the
client never reads, a refusal that leaves the device waiting until its deadline. The proxy speaks TLS 1.2 or
later inside a tunnel and nothing earlier, whatever the Python it runs on would allow. A device that runs past its
deadline is stopped and the request ends with ``PastDeadline``, which the reader's client reports as a request
left unanswered, with how far the device had walked (``proof.android.client``); the failure there is a deadline
read as a JVM that could not start, which a ``TimeoutError`` (an ``OSError``) was.

The device here is a Python process making its requests through the proxy with the authority as its only
trust, as the JVM's client does (CommCare Android's own client is held to the same proxy in
``proof/android/selfcheck.py``, where its runtime is).
"""

from __future__ import annotations

import json
import shutil
import ssl
import sys
import tempfile
import textwrap
import warnings
from pathlib import Path

import pytest

from proof.android import peer as network


@pytest.fixture(autouse=True, scope="module")
def openssl():
    """The proxy's authority is made with the ``openssl`` command, which the lane's image holds. Where it is
    missing every test here fails by name: a skip would pass for a device network nothing held."""
    assert shutil.which("openssl") is not None, (
        "This image holds no openssl command, and the device network's proxy makes its authority and each host's"
        " certificate with it (proof/android/peer.py), so no device request could be answered over https. The"
        " lane's image installs it (proof/image/Dockerfile); build the image again."
    )


DEVICE = textwrap.dedent(
    """
    import json, ssl, sys, urllib.request
    proxy, authority, out = sys.argv[1:4]
    context = ssl.create_default_context(cafile=authority)
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": "http://" + proxy, "https": "http://" + proxy}),
        urllib.request.HTTPSHandler(context=context),
    )
    found = []
    for url, body in (
        ("https://www.commcarehq.org/a/space/phone/restore/?version=2.0&items=true", None),
        ("https://www.commcarehq.org/a/space/receiver/secure/app/", b"<data>form</data>"),
        ("http://staging.commcarehq.org/ota_restore", None),
    ):
        request = urllib.request.Request(url, data=body, headers={"Authorization": "Basic d29ya2VyOnNlY3JldA=="})
        try:
            with opener.open(request, timeout=60) as answer:
                found.append([answer.status, answer.read().decode(), bool(answer.headers.get("Date"))])
        except urllib.error.HTTPError as refused:
            found.append([refused.code, refused.read().decode(), bool(refused.headers.get("Date"))])
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with direct.open("http://" + proxy + "/_proof/run?name=m0%2Ff1", timeout=60) as answer:
        found.append([answer.status])
    open(out, "w").write(json.dumps(found))
    """
)


class Recorded:
    """What answers the device's network here: each request it is handed, answered with what it says it got."""

    def __init__(self, refuse=None):
        self.requests, self.controls, self.refuse = [], [], refuse

    def http(self, request):
        if self.refuse is not None and self.refuse in request.path:
            raise LookupError(f"no answer for {request.path}")
        self.requests.append(request)
        body = f"{request.method} {request.url} {len(request.body)}".encode()
        return 200 if request.method == "GET" else 201, (("Content-Type", "text/plain"),), body

    def control(self, what, name):
        self.controls.append((what, name))


def _serve(peer, scratch: Path):
    authority = network.Authority(scratch / "authority")
    proxy = network.Proxy(peer, authority)
    device, out = scratch / "device.py", scratch / "out.json"
    device.write_text(DEVICE, encoding="utf-8")
    try:
        with open(scratch / "device.log", "wb") as log:
            status = proxy.serve(
                [sys.executable, "-I", str(device), proxy.address, str(authority.certificate), str(out)],
                timeout=120,
                cwd=str(scratch),
                log=log,
            )
    finally:
        proxy.close()
    return status, out


def test_each_request_reaches_the_harness_as_the_client_wrote_it_and_its_answer_reaches_the_client():
    peer = Recorded()
    with tempfile.TemporaryDirectory(prefix="proof-android-peer-") as directory:
        status, out = _serve(peer, Path(directory))
        assert status == 0, (Path(directory) / "device.log").read_text()
        answers = json.loads(out.read_text())
    assert [(r.method, r.scheme, r.host, r.path, r.query) for r in peer.requests] == [
        ("GET", "https", "www.commcarehq.org", "/a/space/phone/restore/", "version=2.0&items=true"),
        ("POST", "https", "www.commcarehq.org", "/a/space/receiver/secure/app/", ""),
        ("GET", "http", "staging.commcarehq.org", "/ota_restore", ""),
    ]
    assert peer.requests[1].body == b"<data>form</data>"
    assert all(r.header("Authorization") == "Basic d29ya2VyOnNlY3JldA==" for r in peer.requests)
    assert answers[:3] == [
        [200, "GET https://www.commcarehq.org/a/space/phone/restore/?version=2.0&items=true 0", True],
        [201, "POST https://www.commcarehq.org/a/space/receiver/secure/app/ 17", True],
        [200, "GET http://staging.commcarehq.org/ota_restore 0", True],
    ]
    assert answers[3] == [200] and peer.controls == [("run", "m0/f1")]


def test_a_request_the_harness_cannot_answer_ends_the_request_after_the_device_is_answered():
    peer = Recorded(refuse="/receiver/")
    with tempfile.TemporaryDirectory(prefix="proof-android-peer-") as directory:
        with pytest.raises(network.PeerFailed, match="receiver/secure/app"):
            _serve(peer, Path(directory))
    # The request before it was answered; nothing after it was asked.
    assert [r.path for r in peer.requests] == ["/a/space/phone/restore/"]


def test_a_device_past_its_deadline_is_stopped_and_reported_as_unanswered_with_how_far_it_walked():
    from proof.android import client

    with tempfile.TemporaryDirectory(prefix="proof-android-peer-") as directory:
        scratch = Path(directory)
        proxy = network.Proxy(Recorded(), network.Authority(scratch / "authority"))
        # A device that ends two walks, writes more than the log's kept end, and then never answers.
        device = "import sys, time\n" + "\n".join(
            f"print('nova-proof walk {name} in 12 ms', file=sys.stderr)" for name in ("root", "m0/@case:patient-2")
        )
        device += f"\nprint('x' * {client.LOG_LIMIT + 1}, file=sys.stderr, flush=True)\ntime.sleep(600)\n"
        log_path = scratch / "device.log"
        try:
            with open(log_path, "wb") as log, pytest.raises(network.PastDeadline) as stopped:
                proxy.serve([sys.executable, "-I", "-c", device], timeout=3, cwd=str(scratch), log=log)
        finally:
            proxy.close()
        assert not isinstance(stopped.value, OSError)
        error = client._unanswered("app", 3, log_path)
    assert "did not answer the app request within 3 s" in str(error)
    assert "It had ended 2 walks, the last m0/@case:patient-2 in 12 ms." in str(error)
    assert len(error.log) <= client.LOG_LIMIT


def _handshake(server: ssl.SSLContext, client: ssl.SSLContext, host: str) -> str:
    """The TLS version the two contexts agree on for ``host``, shaken hands in memory; an ``ssl.SSLError`` where
    they agree on none."""
    to_client, from_client, to_server, from_server = (ssl.MemoryBIO() for _ in range(4))
    sides = {
        "client": (client.wrap_bio(to_client, from_client, server_hostname=host), from_client, to_server),
        "server": (server.wrap_bio(to_server, from_server, server_side=True), from_server, to_client),
    }
    done: set[str] = set()
    for _ in range(20):
        for name, (side, written, read_by_other) in sides.items():
            if name not in done:
                try:
                    side.do_handshake()
                    done.add(name)
                except ssl.SSLWantReadError:
                    pass
            read_by_other.write(written.read())
        if len(done) == 2:
            return sides["client"][0].version()
    raise AssertionError("The two contexts neither shook hands nor refused each other in twenty turns.")


def test_the_proxy_offers_a_device_tls_1_2_or_later_and_nothing_earlier():
    """Contract: inside a tunnel the proxy speaks TLS 1.2 or later for the host the app named. Failure it
    catches: a context left at what its Python allows, which on an older one is TLS 1.0. A client as the app's
    own (the authority its only trust, its versions its defaults) shakes hands at 1.2 or later; one that offers
    nothing later than TLS 1.1 is refused, and the same client shakes hands with a server over the same
    certificate that allows 1.1, so the refusal is the proxy's and not this OpenSSL's."""
    host = "www.commcarehq.org"
    with tempfile.TemporaryDirectory(prefix="proof-android-peer-") as directory:
        authority = network.Authority(Path(directory))
        served = authority.context(host)
        device = ssl.create_default_context(cafile=str(authority.certificate))
        assert _handshake(served, device, host) in {"TLSv1.2", "TLSv1.3"}

        old = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        old.load_verify_locations(str(authority.certificate))
        allowing = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        allowing.load_cert_chain(str(Path(directory) / "host-0.pem"), str(Path(directory) / "host-0.key"))
        with warnings.catch_warnings():
            # Python says of each of these versions that it is deprecated, which is why the proxy refuses them.
            warnings.simplefilter("ignore", DeprecationWarning)
            for context in (old, allowing):
                # OpenSSL keeps TLS 1.1 for its lowest security level alone.
                context.set_ciphers("DEFAULT:@SECLEVEL=0")
                context.minimum_version = ssl.TLSVersion.TLSv1
            old.maximum_version = ssl.TLSVersion.TLSv1_1
        assert _handshake(allowing, old, host) == "TLSv1.1"
        with pytest.raises(ssl.SSLError):
            _handshake(served, old, host)
