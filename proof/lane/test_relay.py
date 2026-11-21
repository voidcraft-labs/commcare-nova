"""``python -m proof.lane.relay``: a lane command the host runs, asked for by name and answered by status.

The contract: the relay names its request as an empty file moved into place
whole and exits with the host's status, pointing to the host job log; it
names only a block's id (a sha256 in hex) or the wait, so nothing the server
passes it becomes a path or a command. The plausible failures: a request
read half written, a status lost, and a block argument that names a path
outside the requests directory. Standard library only, with no image.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from proof.lane import relay

BLOCK = "c" * 64


def test_a_request_is_answered_with_the_hosts_status_and_points_to_its_log(capsys):
    # The host's answer is in place before the relay asks, so the relay returns at its first look, with no wait.
    with tempfile.TemporaryDirectory() as scratch:
        requests, answers = Path(scratch, "requests"), Path(scratch, "answers")
        requests.mkdir()
        answers.mkdir()
        staged = answers / "staged"
        staged.write_text("1\n", encoding="utf-8")
        os.replace(staged, answers / f"claim-{BLOCK}.code")
        code = relay.main(["--requests", str(requests), "--answers", str(answers), "claim", BLOCK])
        assert code == 1
        assert "status 1. The shard's job log" in capsys.readouterr().out
        # The request is the one name, moved into place whole: nothing staged is left beside it.
        assert sorted(path.name for path in requests.iterdir()) == [f"claim-{BLOCK}.request"]


def test_a_claim_names_only_a_block_id_and_the_wait_none():
    with tempfile.TemporaryDirectory() as scratch:
        requests, answers = Path(scratch, "requests"), Path(scratch, "answers")
        requests.mkdir()
        answers.mkdir()
        for argv in (["claim", "../../escape"], ["claim"], ["claim", BLOCK.upper()], ["wait", BLOCK]):
            assert relay.main(["--requests", str(requests), "--answers", str(answers), *argv]) == relay.REFUSED
        assert list(requests.iterdir()) == []
