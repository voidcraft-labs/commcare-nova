"""Where an Android device's network goes: a loopback HTTP proxy the reader answers from.

A device the lane serves has a network (``proof/android/README.md``, "The network"). The app's own HTTP client
(Core's ``CommCareNetworkServiceGenerator``, which every request of the app's requester and data pull goes
through) is given this proxy as a device on a network with a proxy is given one (``Peer.java``): a plain
request is sent to it whole, and an ``https`` one through a tunnel it asks for with ``CONNECT``, inside which
this side speaks TLS for the host the app named, with a certificate of its own authority that the device is
given to trust (``Authority``). So every address the app names, whatever its host, reaches this proxy, and the
request read here is the one the app wrote, its scheme, host, path, headers and body. The app's client keeps
everything else of its own (its interceptors, its credentials, its refusal to send a password in clear).

Each request is answered by ``peer.http`` (``proof.android.hq``: HQ's own views over the state the device is
served), on the thread that runs the reader, which in the lane is the thread that holds HQ's unit. The device
also tells the harness where each of its sessions begins (``CONTROL``, on a connection that bypasses the
proxy), and those messages go to ``peer.control``.

Connections are read on threads of their own, so a request the app makes while another is open never waits on
it; every answer is written from the reader's thread, one at a time, in the order the requests arrived. A
device of the lane makes one request at a time (its tasks wait for each answer), so the order is the app's.

Standard library only, and the ``openssl`` command, which the image holds with its certificate store and every
machine the reader runs on has.
"""

from __future__ import annotations

import collections
import email.utils
import http.client
import os
import selectors
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# How long a connection may wait for the device's request, or for the device to read its answer.
SOCKET_SECONDS = 120.0
# The device's own messages to the harness (Peer.java CONTROL), sent to the proxy's address with no proxy;
# HQ's URLconf names nothing under it, and the device never names the proxy's address for a server.
CONTROL = "/_proof/"
# Headers of the device's connection with the proxy, which an answer writes for itself.
_HOP_HEADERS = {"connection", "content-length", "transfer-encoding", "keep-alive", "proxy-connection"}
# A request line or header longer than this is no request a device wrote.
_LINE_LIMIT = 65536
# How long the certificates the authority makes are valid: a request's life, with room.
_CERTIFICATE_DAYS = "7"


class PeerFailed(Exception):
    """What answers the device's network raised, which ends the request: the harness's refusal, never HQ's
    answer (HQ's own views answer what they refuse)."""


@dataclass(frozen=True)
class DeviceRequest:
    """One request the device's network sent, as the app wrote it: ``scheme`` and ``host`` are the address the
    app named (a tunnel's for ``https``), ``path`` and ``query`` its target."""

    method: str
    scheme: str
    host: str
    path: str
    query: str
    headers: tuple
    body: bytes

    def header(self, name: str):
        for key, value in self.headers:
            if key.lower() == name.lower():
                return value
        return None

    @property
    def url(self) -> str:
        return f"{self.scheme}://{self.host}{self.path}" + (f"?{self.query}" if self.query else "")


class Authority:
    """A certificate authority of the harness's own, which the device is given to trust, and a server
    certificate it signs for each host the device opens a tunnel to, made with ``openssl`` in ``directory``."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.certificate = self.directory / "authority.pem"
        self._key = self.directory / "authority.key"
        self._contexts: dict[str, ssl.SSLContext] = {}
        self._lock = threading.Lock()
        config = self.directory / "authority.cnf"
        config.write_text(
            "[req]\ndistinguished_name=dn\n[dn]\n"
            "[authority]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n"
            "subjectKeyIdentifier=hash\n",
            encoding="ascii",
        )
        self._openssl(
            "req", "-x509", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
            "-keyout", str(self._key), "-out", str(self.certificate), "-days", _CERTIFICATE_DAYS,
            "-subj", "/CN=Nova proof lane device network", "-config", str(config), "-extensions", "authority",
        )  # fmt: skip

    def _openssl(self, *arguments: str) -> None:
        result = subprocess.run(
            ["openssl", *arguments], cwd=self.directory, stdin=subprocess.DEVNULL, capture_output=True, check=False
        )
        if result.returncode != 0:
            raise PeerFailed(
                f"openssl {arguments[0]} exited {result.returncode} making the device network's certificates: "
                + result.stderr.decode("utf-8", "replace")[-2000:]
            )

    def context(self, host: str) -> ssl.SSLContext:
        """A server's TLS context for ``host``, its certificate signed by the authority."""
        with self._lock:
            held = self._contexts.get(host)
            if held is not None:
                return held
            name = f"host-{len(self._contexts)}"
            key, request, certificate = (self.directory / f"{name}.{suffix}" for suffix in ("key", "csr", "pem"))
            config = self.directory / f"{name}.cnf"
            config.write_text(
                "[req]\ndistinguished_name=dn\n[dn]\n"
                "[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
                f"extendedKeyUsage=serverAuth\nsubjectAltName=DNS:{host}\n",
                encoding="ascii",
            )
            self._openssl(
                "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                "-keyout", str(key), "-out", str(request), "-subj", f"/CN={host}", "-config", str(config),
            )  # fmt: skip
            self._openssl(
                "x509", "-req", "-in", str(request), "-CA", str(self.certificate), "-CAkey", str(self._key),
                "-set_serial", str(int.from_bytes(os.urandom(8), "big")), "-days", _CERTIFICATE_DAYS,
                "-out", str(certificate), "-extfile", str(config), "-extensions", "server",
            )  # fmt: skip
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(certificate), str(key))
            self._contexts[host] = context
            return context


class _Read:
    """A connection's stream, read line by line and by length."""

    def __init__(self, connection):
        self.stream = connection.makefile("rb")

    def line(self) -> bytes:
        line = self.stream.readline(_LINE_LIMIT + 1)
        if len(line) > _LINE_LIMIT:
            raise PeerFailed("The device wrote a request line or header longer than any request holds.")
        return line

    def message(self):
        """The headers and body of an HTTP message whose start line was read."""
        headers = http.client.parse_headers(self.stream)
        if (headers.get("Transfer-Encoding") or "").lower() == "chunked":
            body = bytearray()
            while True:
                size = int(self.line().split(b";", 1)[0].strip(), 16)
                if size == 0:
                    while self.line() not in (b"\r\n", b"\n", b""):
                        pass
                    break
                body += self.stream.read(size)
                self.line()
            return headers, bytes(body)
        return headers, self.stream.read(int(headers.get("Content-Length") or 0))

    def close(self):
        self.stream.close()


@dataclass
class _Pending:
    """A request read off a connection, waiting for its answer."""

    connection: socket.socket
    request: DeviceRequest | None = None
    control: str | None = None
    name: str = ""


def _start_line(read: _Read):
    line = read.line()
    if not line:
        return None
    parts = line.decode("latin-1").rstrip("\r\n").split(" ")
    if len(parts) != 3:
        raise PeerFailed(f"The device wrote a request line no HTTP request has: {line[:200]!r}.")
    return parts


def _read_pending(connection: socket.socket, authority: Authority) -> _Pending | None:
    """The request on a connection the device opened: a tunnel's inner request, a plain request sent to the
    proxy whole, or a control message; None where the device closed the connection without one."""
    connection.settimeout(SOCKET_SECONDS)
    read = _Read(connection)
    try:
        start = _start_line(read)
        if start is None:
            return None
        method, target, _version = start
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            if not host or not port.isdigit():
                raise PeerFailed(f"The device asked for a tunnel to {target!r}, which names no host and port.")
            read.message()
            connection.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            read.close()
            tunnel = authority.context(host).wrap_socket(connection, server_side=True)
            tunnel.settimeout(SOCKET_SECONDS)
            inner = _Read(tunnel)
            try:
                start = _start_line(inner)
                if start is None:
                    return None
                method, target, _version = start
                headers, body = inner.message()
            finally:
                inner.close()
            address = urlsplit(target)
            request = DeviceRequest(method, "https", host, address.path, address.query, tuple(headers.items()), body)
            return _Pending(tunnel, request=request)
        headers, body = read.message()
        address = urlsplit(target)
        if not address.scheme:
            if not address.path.startswith(CONTROL):
                raise PeerFailed(
                    f"The device sent the proxy {method} {target} with no address, which only its own messages to"
                    f" the harness ({CONTROL}) do."
                )
            name = (parse_qs(address.query).get("name") or [""])[0]
            return _Pending(connection, control=address.path[len(CONTROL) :], name=name)
        request = DeviceRequest(
            method, address.scheme, address.netloc, address.path, address.query, tuple(headers.items()), body
        )
        return _Pending(connection, request=request)
    finally:
        read.close()


def write_answer(connection, status: int, headers, body: bytes) -> None:
    """The answer as an HTTP server in front of HQ writes it: with a ``Date`` where HQ's view wrote none, which
    HQ leaves to its web server (an origin server with a clock sends one, RFC 9110 6.6.1) and the device reads
    (``CommCareNetworkServiceGenerator``'s drift interceptor, against its own clock). The server and the device
    share this machine's clock, as a server and a device share the time of day, so the device sees no drift."""
    reason = http.client.responses.get(status, "")
    lines = [f"HTTP/1.1 {status} {reason}"]
    lines += [f"{name}: {value}" for name, value in headers if name.lower() not in _HOP_HEADERS]
    if not any(name.lower() == "date" for name, _ in headers):
        lines.append(f"Date: {email.utils.formatdate(time.time(), usegmt=True)}")
    lines += [f"Content-Length: {len(body)}", "Connection: close", "", ""]
    connection.sendall("\r\n".join(lines).encode("latin-1") + body)


class Proxy:
    """The loopback proxy one device's network goes through, for one JVM's life."""

    def __init__(self, peer, authority: Authority):
        self.peer = peer
        self.authority = authority
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(32)
        self.address = "%s:%d" % self.listener.getsockname()
        self._ready: collections.deque[_Pending] = collections.deque()
        self._failures: list[BaseException] = []
        self._lock = threading.Lock()
        self._wake_read, self._wake_write = socket.socketpair()
        self._readers: list[threading.Thread] = []
        self._closing = False

    def _accept(self) -> None:
        connection, _ = self.listener.accept()
        reader = threading.Thread(target=self._read, args=(connection,), daemon=True, name="android-peer-read")
        self._readers.append(reader)
        reader.start()

    def _read(self, connection: socket.socket) -> None:
        try:
            pending = _read_pending(connection, self.authority)
        except BaseException as error:  # noqa: BLE001 - the reader's thread hands every failure to the answerer
            with self._lock:
                self._failures.append(error)
            connection.close()
        else:
            if pending is None:
                connection.close()
                return
            with self._lock:
                self._ready.append(pending)
        try:
            self._wake_write.send(b"x")
        except OSError:
            pass

    def _answer_ready(self) -> None:
        while True:
            with self._lock:
                if self._failures:
                    failure = self._failures.pop(0)
                    if not self._closing:
                        raise PeerFailed(f"A connection the Android device opened could not be read: {failure!r}")
                if not self._ready:
                    return
                pending = self._ready.popleft()
            with pending.connection:
                try:
                    if pending.control is not None:
                        self.peer.control(pending.control, pending.name)
                        status, headers, body = 200, (), b""
                    else:
                        status, headers, body = self.peer.http(pending.request)
                except BaseException as error:
                    try:
                        write_answer(pending.connection, 503, (), b"")
                    except OSError:
                        pass
                    what = (
                        f"the device's message {pending.control}"
                        if pending.control is not None
                        else f"{pending.request.method} {pending.request.url}"
                    )
                    raise PeerFailed(
                        f"What answers the Android device's network raised on {what}: {error!r}"
                    ) from error
                try:
                    write_answer(pending.connection, status, headers, body)
                except OSError:
                    # A device that stopped waiting for its answer (its JVM ended) reads none.
                    if not self._closing:
                        raise

    def serve(self, command, *, timeout: float, cwd, log) -> int:
        """Runs the JVM to its end, answering each request its device makes as it comes; the JVM's exit status.
        Past ``timeout`` the JVM is stopped and ``TimeoutError`` raised."""
        deadline = time.perf_counter() + timeout
        selector = selectors.DefaultSelector()
        selector.register(self.listener, selectors.EVENT_READ, "accept")
        selector.register(self._wake_read, selectors.EVENT_READ, "wake")
        process = _Process(command, cwd=cwd, log=log)
        if process.fileno() is not None:
            selector.register(process, selectors.EVENT_READ, "exited")
        try:
            while True:
                left = deadline - time.perf_counter()
                if left <= 0:
                    process.stop()
                    raise TimeoutError(f"The Android reader's JVM ran past {timeout} s.")
                if process.exited():
                    break
                ready = selector.select(timeout=min(left, 0.25))
                kinds = {key.data for key, _ in ready}
                if "wake" in kinds:
                    self._wake_read.recv(4096)
                if "accept" in kinds:
                    self._accept()
                self._answer_ready()
                if "exited" in kinds:
                    break
            # What the device sent as it ended is read and answered too, so no request is left unanswered.
            self._closing = True
            self.listener.setblocking(False)
            while True:
                try:
                    self._accept()
                except (BlockingIOError, OSError):
                    break
            for reader in self._readers:
                reader.join(SOCKET_SECONDS)
            self._answer_ready()
            return process.stop()
        except BaseException:
            self._closing = True
            process.stop()
            raise
        finally:
            selector.close()

    def close(self) -> None:
        self._closing = True
        for sock in (self.listener, self._wake_read, self._wake_write):
            sock.close()


class _Process:
    """The JVM, in a process group of its own: through ``proof.processes`` on Linux, which reaps everything it
    started, and as a session leader killed whole on macOS, where a person runs the reader by hand."""

    def __init__(self, command, *, cwd, log):
        if sys.platform.startswith("linux"):
            from proof import processes

            self._group = processes.ProcessGroup(command, cwd=cwd, stdout=log, stderr=log)
            self._popen = None
        else:
            self._group = None
            self._popen = subprocess.Popen(
                command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True
            )

    def fileno(self):
        return self._group.fileno() if self._group is not None else None

    def exited(self) -> bool:
        return self._popen is not None and self._popen.poll() is not None

    def stop(self) -> int:
        if self._group is not None:
            self._group.stop()
            return self._group.returncode
        if self._popen.poll() is None:
            os.killpg(self._popen.pid, signal.SIGKILL)
        return self._popen.wait()


def authority(directory: Path | None = None) -> Authority:
    """An authority in ``directory``, or in a directory of its own."""
    return Authority(Path(directory) if directory is not None else Path(tempfile.mkdtemp(prefix="proof-android-ca-")))
