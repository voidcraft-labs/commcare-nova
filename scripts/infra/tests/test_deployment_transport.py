"""Use real local HTTP failures; only Google's endpoint address is redirected."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import threading
import unittest
import urllib.parse
import urllib.request
from unittest.mock import patch

from deployment_fixtures import deploy, JOB, http_error


@contextmanager
def admin_server(replies):
    received = []
    pending = iter(replies)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            received.append((self.command, self.path, body))
            reply = next(pending)
            if reply == "disconnect":
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            if reply in ("truncated", "truncated-403"):
                self.send_response(403 if reply == "truncated-403" else 200)
                self.send_header("Content-Length", "100")
                self.end_headers()
                self.wfile.write(b'{"incomplete":')
                self.wfile.flush()
                self.close_connection = True
                return
            status, value = reply
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = respond
        do_POST = respond

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01))
    thread.start()
    original_open = urllib.request.urlopen

    def local_open(request, **kwargs):
        # Preserve the real serializer, HTTP method, headers, timeout and body.
        # The only replacement is Google's unavailable local endpoint address.
        local = urllib.request.Request(
            "http://127.0.0.1:" + str(server.server_port) + urllib.parse.urlsplit(request.full_url).path,
            data=request.data, method=request.get_method(), headers=dict(request.header_items()),
        )
        return original_open(local, **kwargs)

    try:
        with patch("urllib.request.urlopen", side_effect=local_open):
            yield received
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        if thread.is_alive():
            raise AssertionError("HTTP fixture did not stop")


class DeploymentTransportTests(unittest.TestCase):
    def test_transient_get_recovers_from_http_disconnect_and_partial_response(self):
        for failure in ((503, {"error": "unavailable"}), "disconnect", "truncated"):
            with self.subTest(failure=failure):
                with admin_server([failure, (200, {"ready": True})]) as received, patch.object(
                    deploy.time, "sleep",
                ):
                    result = deploy._wait_for(
                        "ready response", lambda: deploy._run_api_request("synthetic", "GET", JOB),
                        timeout_seconds=10,
                    )
                self.assertEqual(result, {"ready": True})
                self.assertEqual([method for method, _, _ in received], ["GET", "GET"])

    def test_uncertain_post_is_terminal_and_never_submitted_twice(self):
        for failure in ((503, {"error": "unavailable"}), "disconnect", "truncated"):
            with self.subTest(failure=failure):
                with admin_server([failure]) as received:
                    with self.assertRaises(deploy.TerminalDeploymentPolicyError):
                        deploy._run_api_request("synthetic", "POST", JOB + ":run", {"etag": "generation-3"})
                self.assertEqual(received, [("POST", "/v2/" + JOB + ":run", b'{"etag":"generation-3"}')])

    def test_http_error_response_is_closed_after_classification(self):
        error = http_error(403)
        try:
            with patch("urllib.request.urlopen", side_effect=error):
                with self.assertRaises(deploy.TerminalDeploymentPolicyError):
                    deploy._run_api_request("synthetic", "GET", JOB)
            self.assertTrue(error.closed)
        finally:
            error.close()

    def test_authorization_status_remains_terminal_when_its_error_body_is_cut_short(self):
        with admin_server(["truncated-403"]) as received, patch.object(deploy.time, "sleep") as sleep:
            with self.assertRaisesRegex(deploy.TerminalDeploymentPolicyError, "HTTP 403"):
                deploy._wait_for("read", lambda: deploy._run_api_request("synthetic", "GET", JOB))
        self.assertEqual([method for method, _, _ in received], ["GET"])
        sleep.assert_not_called()
