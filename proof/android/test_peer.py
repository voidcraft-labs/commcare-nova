"""The device's network: what a client sends through the reader's proxy reaches the harness as it was written.

Contract (``proof.android.peer``): every request a device's HTTP client makes through the proxy, a plain one
sent whole or an ``https`` one through a tunnel inside which the proxy speaks TLS with a certificate of its own
authority, reaches ``peer.http`` with the scheme, host, path, query, headers and body the client wrote; the
answer reaches the client with a ``Date`` the server's clock wrote where the answer had none; a message of the
device's own reaches ``peer.control``; and what answers the network refusing a request ends the request with
``PeerFailed`` after the device is answered. Plausible failures: a tunnel whose inner request is read as the
tunnel's (a lost path, a lost body), a body cut at a chunk, a certificate the client refuses, an answer the
client never reads, a refusal that leaves the device waiting until its deadline.

The device here is a Python process making its requests through the proxy with the authority as its only
trust, as the JVM's client does (CommCare Android's own client is held to the same proxy in
``proof/android/selfcheck.py``, where its runtime is).
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import textwrap
from pathlib import Path

import pytest

from proof.android import peer as network

pytestmark = pytest.mark.skipif(shutil.which("openssl") is None, reason="the proxy's authority is made with openssl")

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
