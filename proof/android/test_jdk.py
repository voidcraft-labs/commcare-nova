"""The JDK setup owns transient retries, verifies bytes, and fails closed before readers.

A real local HTTP peer controls only the release server's responses. No Java
process is simulated: these checks prove archive acquisition and installation;
the runtime action separately executes the pinned Java and its real reader.
"""

import hashlib
import io
import tarfile
import tempfile
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

from proof.android import jdk


def archive_bytes():
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as packed:
        for name, content in {"jdk/bin/java": b"fixture executable", "jdk/release": b'JAVA_VERSION="17.0.13"'}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            entry.mode = 0o755 if name.endswith("java") else 0o644
            packed.addfile(entry, io.BytesIO(content))
    return stream.getvalue()


@contextmanager
def release(statuses, content, *, truncate_first=False, hold_body=None, stream_forever=False):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            status = statuses[min(len(requests), len(statuses) - 1)]
            requests.append(self.path)
            self.send_response(status)
            self.send_header("Content-Length", str(10**12 if stream_forever else len(content)))
            self.end_headers()
            if stream_forever:
                try:
                    while True:
                        self.wfile.write(b"x")
                except (BrokenPipeError, ConnectionResetError):
                    return
            if hold_body is not None:
                hold_body.wait()
                return
            self.wfile.write(content[: len(content) // 2] if truncate_first and len(requests) == 1 else content)

        def log_message(self, *args):
            pass

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            yield (
                {
                    "url": f"http://127.0.0.1:{server.server_port}/pinned-jdk",
                    "sha256": hashlib.sha256(content).hexdigest(),
                },
                requests,
            )
        finally:
            if hold_body is not None:
                hold_body.set()
            server.shutdown()
            thread.join()


class PinnedJdk(unittest.TestCase):
    def test_transient_release_failure_recovers_and_consumers_reuse_verified_bytes(self):
        with tempfile.TemporaryDirectory() as scratch, release([504, 200], archive_bytes()) as (pin, requests):
            root = Path(scratch)
            archive, target = root / "jdk.tar.gz", root / "java"
            with patch.object(jdk.time, "sleep") as pause:
                jdk.prepare(archive, target, allow_download=True, pin=pin)
            self.assertEqual(pause.call_args_list, [unittest.mock.call(5)])
            self.assertEqual(len(requests), 2)
            self.assertEqual((target / "bin/java").read_bytes(), b"fixture executable")
            # Re-extract from the verified archive even if an installed tree was damaged.
            (target / "bin/java").write_bytes(b"changed")
            jdk.prepare(archive, target, pin=pin)
            self.assertEqual(len(requests), 2)
            self.assertEqual((target / "bin/java").read_bytes(), b"fixture executable")
            archive.write_bytes(b"corrupt cache")
            with self.assertRaisesRegex(jdk.JdkUnavailable, "SHA-256"):
                jdk.prepare(archive, target, pin=pin)
            self.assertEqual(len(requests), 2)

    def test_unavailable_prerequisite_never_leaves_an_archive_or_usable_installation(self):
        for status, attempts in [(504, 3), (404, 1)]:
            with (
                self.subTest(status=status),
                tempfile.TemporaryDirectory() as scratch,
                release([status], b"unavailable") as (pin, requests),
            ):
                root = Path(scratch)
                with (
                    patch.object(jdk.time, "sleep") as pause,
                    self.assertRaisesRegex(jdk.JdkUnavailable, f"after {attempts} attempt"),
                ):
                    jdk.prepare(root / "jdk.tar.gz", root / "java", allow_download=True, pin=pin)
                self.assertEqual(len(requests), attempts)
                self.assertEqual(pause.call_count, attempts - 1)
                self.assertEqual(list(root.iterdir()), [])

    def test_shards_never_download_a_missing_archive_and_corrupt_downloads_are_not_cached(self):
        with tempfile.TemporaryDirectory() as scratch, release([200], archive_bytes()) as (pin, requests):
            root = Path(scratch)
            with self.assertRaisesRegex(jdk.JdkUnavailable, "missing from the runtime cache"):
                jdk.prepare(root / "jdk.tar.gz", root / "java", pin=pin)
            self.assertEqual(requests, [])
            pin["sha256"] = "0" * 64
            with self.assertRaisesRegex(jdk.JdkUnavailable, "SHA-256"):
                jdk.prepare(root / "jdk.tar.gz", root / "java", allow_download=True, pin=pin)
            self.assertEqual(len(requests), 1)
            self.assertEqual(list(root.iterdir()), [])

    def test_a_verified_archive_still_needs_a_jdk_layout(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz"):
            pass
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            archive = root / "jdk.tar.gz"
            archive.write_bytes(stream.getvalue())
            with self.assertRaisesRegex(jdk.JdkUnavailable, "does not contain one JDK"):
                jdk.prepare(archive, root / "java", pin={"sha256": hashlib.sha256(stream.getvalue()).hexdigest()})
            self.assertFalse((root / "java").exists())

    def test_a_truncated_successful_response_is_retried_before_verifying_the_archive(self):
        with (
            tempfile.TemporaryDirectory() as scratch,
            release([200], archive_bytes(), truncate_first=True) as (pin, requests),
        ):
            root = Path(scratch)
            with patch.object(jdk.time, "sleep"):
                jdk.prepare(root / "jdk.tar.gz", root / "java", allow_download=True, pin=pin)
            self.assertEqual(len(requests), 2)
            self.assertEqual((root / "java/bin/java").read_bytes(), b"fixture executable")

    def test_a_stalled_body_ends_at_the_transfer_deadline(self):
        held = threading.Event()
        with (
            tempfile.TemporaryDirectory() as scratch,
            release([200], archive_bytes(), hold_body=held) as (pin, requests),
        ):
            with patch.object(jdk, "DOWNLOAD_SECONDS", 1):
                transient, error = jdk.transfer(pin["url"], Path(scratch) / "partial")
            self.assertTrue(transient)
            self.assertIn("curl exit 28", error)
            self.assertEqual(len(requests), 1)

    def test_a_continuing_response_cannot_outlive_the_total_transfer_deadline(self):
        with tempfile.TemporaryDirectory() as scratch, release([200], b"", stream_forever=True) as (pin, requests):
            with patch.object(jdk, "DOWNLOAD_SECONDS", 1):
                transient, error = jdk.transfer(pin["url"], Path(scratch) / "partial")
            self.assertTrue(transient)
            self.assertIn("curl exit 28", error)
            self.assertEqual(len(requests), 1)
