"""A failed night's issue names each failing group and the command that reruns it alone.

Contract (``proof.lane.report``): from the lanes' verdicts, the issue's body names the commit the run checked,
and for each lane each group a problem names, why, and the exact lines that rerun that group as its lane ran it
and hold the slice to the gate: on any machine with Docker for a lane without the readers, on a proof machine for
a lane with them, where a group that fails without the readers too is sent there first. A document's group reruns
every item of it, a package's its failing items, each by node id; a group that never ran is selected by path and
says it may select more. A lane with no verdict is named as that, and a failing lane whose problems name no group
quotes them. The plausible failures: an issue that says only that the night failed, a command that reruns more
than the group (a ``-k`` another document's name contains) or one the reader cannot paste, a reader's failure
sent to a machine with no reader, and a lane that died before its gate passing for one that held. The weekly's
comparison lanes check a sample that turns each week, so its issue names the seed and each sampled lane's
documents, and the dispatch that runs the same sample again; a failure on a sample no one can name again is one.
A failed piece (one configuration of a document observed by a group of its own) is named as that, with the line
that observes that configuration again alone, whether or not its item ran; the document's group it kept from
running reruns every item of the document. The plausible failure: a piece's failure sent to rerun the whole
document, or named with a line that selects nothing.
"""

from __future__ import annotations

import json

from proof.lane import report


def _verdict(readers, failing, *, problems=("a problem",)):
    return {
        "holds": not failing and not problems,
        "sections": {
            "exactlyOnce": {"holds": True, "problems": [], "notes": []},
            "tests": {"holds": True, "problems": [], "notes": []},
            "register": {"holds": not problems, "problems": list(problems), "notes": [], "readers": readers},
            "surface": {"holds": True, "problems": [], "notes": []},
        },
        "failing": failing,
    }


DOCUMENT = {
    "group": "corpus:tile",
    "why": ["1 of its 2 items failed", "The known-defect entry d1 names bar on tile, and no shard ran bar on tile."],
    "failed": ["checks/test_bar.py::test_every_export_meets_the_bar[tile]"],
    "items": [
        "checks/test_bar.py::test_every_export_meets_the_bar[tile]",
        "hq/test_branches.py::test_a_documents_branches_hold[tile]",
    ],
}
PACKAGE = {
    "group": "proof/lane",
    "why": ["2 of its 40 items failed"],
    "failed": ["lane/test_gate.py::test_a", "lane/test_plan.py::test_b[x y]"],
    "items": [f"lane/test_gate.py::test_{index}" for index in range(40)],
}


def test_each_failing_group_is_named_with_the_command_that_reruns_it_alone_where_it_can_run():
    lanes = [
        ("audit", _verdict(True, [DOCUMENT, PACKAGE])),
        ("audit-no-readers", _verdict(False, [DOCUMENT])),
    ]
    body = report.body("nightly", "https://example.test/run/1", "abc123", lanes)
    assert "over main at `abc123`" in body and "The run: https://example.test/run/1" in body
    assert "git fetch origin && git checkout abc123" in body
    with_readers, without = body.split("### Lane `audit-no-readers`")
    # With the readers: a proof machine, every item of the document's group by node id, and the gate over it.
    assert "### Lane `audit` (with every reader)" in with_readers
    assert "2 groups failed where a reader ran, so each reruns on a proof machine" in with_readers
    assert (
        "  proof/remote/run.sh <host> -- 'proof/checks/test_bar.py::test_every_export_meets_the_bar[tile]'"
        " 'proof/hq/test_branches.py::test_a_documents_branches_hold[tile]'\n"
        "  python3 -m proof.lane.gate .proof/remote/<the directory run.sh names>"
    ) in with_readers
    assert "- `corpus:tile`: 1 of its 2 items failed; The known-defect entry d1 names bar on tile" in with_readers
    assert "It fails without the readers too, so rerun it there first" in with_readers
    # A package's group reruns its failing items, each quoted as a shell takes it.
    assert "proof/remote/run.sh <host> -- proof/lane/test_gate.py::test_a 'proof/lane/test_plan.py::test_b[x y]'" in (
        with_readers
    )
    assert with_readers.count("It fails without the readers too") == 1
    # Without the readers: any machine with Docker.
    assert "(with no reader)" in without and "1 group failed without the readers" in without
    assert (
        "  PROOF_READERS=0 npm run proof -- 'proof/checks/test_bar.py::test_every_export_meets_the_bar[tile]'"
        " 'proof/hq/test_branches.py::test_a_documents_branches_hold[tile]'\n"
        "  python3 -m proof.lane.gate .proof/out"
    ) in without
    assert "may run more" not in body


def test_a_slice_of_readers_a_group_that_never_ran_and_a_lane_without_a_verdict_are_each_said(tmp_path):
    never_ran = {"group": "corpus:tile", "why": ["no shard's output holds its block"], "failed": [], "items": []}
    control = {"group": "control:tile-control", "why": ["no shard's output holds its block"], "failed": [], "items": []}
    module = {"group": "proof/editors/test_pages.py", "why": ["it did not finish: killed"], "failed": [], "items": []}
    lanes = [
        ("weekly-verified", _verdict(["formplayer", "android"], [never_ran, control, module])),
        ("weekly-no-readers", None),
        ("weekly-baseline", {**_verdict(True, [], problems=()), "holds": True}),
        ("weekly-unseeded", _verdict(True, [], problems=("The queues were built for different readers.",))),
    ]
    body = report.body("weekly", "https://example.test/run/2", "def456", lanes)
    assert "proof/remote/run.sh <host> --env PROOF_READERS=formplayer,android -- proof/checks -k tile\n" in body
    assert "-- proof/checks -k control-tile-control\n" in body
    assert "-- proof/editors/test_pages.py\n" in body
    # The document and the control are selected by name, which may select more; the module is itself.
    assert body.count("Its items could not be named one by one, so this selects by path and may run more.") == 2
    assert "### Lane `weekly-no-readers`\n\nIt uploaded no verdict" in body
    assert "### Lane `weekly-baseline` (with every reader)\n\nIts verdict held." in body
    assert "sample_seed" not in body
    unseeded = body.split("### Lane `weekly-unseeded`")[1]
    assert "- Fails: Every difference holds to the register (1 problem). The first:" in unseeded
    assert "  - The queues were built for different readers." in unseeded
    assert "No problem names one group, so there is no slice to rerun" in unseeded

    # The command reads each lane's verdict file, and one that is absent or not a verdict is a lane without one.
    held = tmp_path / "held.json"
    held.write_text(json.dumps({**_verdict(False, [], problems=()), "holds": True}))
    out = tmp_path / "issue.md"
    arguments = ["--kind", "nightly", "--run", "u", "--commit", "c", "--out", str(out)]
    assert report.main([*arguments, "--lane", f"audit-no-readers={held}", "--lane", f"audit={tmp_path}/none"]) == 0
    written = out.read_text()
    assert "### Lane `audit-no-readers` (with no reader)\n\nIts verdict held." in written
    assert "### Lane `audit`\n\nIt uploaded no verdict" in written
    assert report.main([*arguments, "--lane", "audit"]) == 2


def test_a_weeks_issue_names_the_sample_and_the_seed_that_runs_it_again():
    sampled = {
        **_verdict(True, [], problems=()),
        "holds": True,
        "sample": {"seed": "2026-W42", "documents": ["a", "b"]},
    }
    failed = {**_verdict(True, [DOCUMENT]), "sample": {"seed": "2026-W42", "documents": ["a", "b"]}}
    lanes = [("weekly-baseline", sampled), ("weekly-unseeded", failed), ("weekly-verified", _verdict(True, [DOCUMENT]))]
    body = report.body("weekly", "u", "c", lanes, "2026-W42")
    assert "the corpus sample the seed `2026-W42` chooses, which turns each week" in body
    assert "gh workflow run proof-audit.yml -f nightly=false -f weekly=true -f sample_seed=2026-W42" in body
    line = "It checked a sample of 2 documents (seed `2026-W42`): a, b."
    assert f"### Lane `weekly-baseline` (with every reader)\n\n{line}\n\nIts verdict held." in body
    assert f"### Lane `weekly-unseeded` (with every reader)\n\n{line}\n\n- Fails:" in body
    # A lane over the whole corpus names no sample.
    assert "It checked a sample" not in body.split("### Lane `weekly-verified`")[1]


def test_a_whole_lanes_issue_names_each_effect_the_file_and_the_run_disagree_on(tmp_path):
    """The lane that held the committed sensitivity effects to its own flips (``effects.json`` beside its verdict):
    each stale effect and each the file lacks is named, with the lines that write them again from that run; a lane
    that held them says so, and one that did not hold them (no file) says nothing of them."""
    effects = {
        "holds": False,
        "stale": [{"gate": "toggle/A", "artifact": "suite.xml", "path": "/suite/menu[*]"}],
        "lacking": [
            {"gate": "toggle/B", "artifact": "suite.xml", "path": "/suite/x"},
            {"gate": "toggle/B", "artifact": "suite.xml", "path": "/suite/y"},
        ],
        "problems": [
            "toggle/A names the effect suite.xml /suite/menu[*], and no flip of it in this run showed that: a stale"
            " effect.",
            "A flip of toggle/B showed suite.xml /suite/x, which its effects do not name.",
            "A flip of toggle/B showed suite.xml /suite/y, which its effects do not name.",
        ],
    }
    held = {**_verdict(False, [], problems=()), "holds": True}
    for label, found in (("weekly-no-readers", effects), ("held", {**effects, "holds": True, "problems": []})):
        directory = tmp_path / label
        directory.mkdir()
        (directory / "verdict.json").write_text(json.dumps(held))
        (directory / "effects.json").write_text(json.dumps(found))
    (tmp_path / "apart").mkdir()
    (tmp_path / "apart" / "verdict.json").write_text(json.dumps(held))
    out = tmp_path / "issue.md"
    lanes = [f"--lane={label}={tmp_path / label / 'verdict.json'}" for label in ("weekly-no-readers", "held", "apart")]
    run = "https://example.test/o/r/actions/runs/4242"
    assert report.main(["--kind", "weekly", "--run", run, "--commit", "c", "--out", str(out), *lanes]) == 0
    body = out.read_text()
    failed, rest = body.split("### Lane `held`")
    assert "### Lane `weekly-no-readers` (with no reader)\n\nIts verdict held." in failed
    assert "are not what this run's flips showed, over every document observed afresh: 1 effect the file" in failed
    assert "names that no flip showed, 2 effects a flip showed that the file lacks." in failed
    assert "- toggle/A names the effect suite.xml /suite/menu[*], and no flip of it in this run showed that" in failed
    assert "- A flip of toggle/B showed suite.xml /suite/y, which its effects do not name." in failed
    assert "gh run download 4242 --pattern 'proof-out-weekly-no-readers-*' --dir proof-outputs" in failed
    assert (
        "python3 -m proof.checks.sensitivity effects proof-outputs/proof-out-*/blocks/* --corpus proof-corpus" in failed
    )
    held_lane, apart = rest.split("### Lane `apart`")
    assert "The committed sensitivity effects are what this run's flips showed." in held_lane
    assert "sensitivity effects" not in apart
    assert "the committed sensitivity effects are not what the whole fresh run's flips showed" in body


def test_a_package_with_more_failures_than_a_command_names_reruns_the_modules_that_hold_them():
    failed = [f"lane/test_gate.py::test_{index}" for index in range(report.MOST_ITEMS + 1)]
    many = {"group": "proof/lane", "why": ["13 of its 40 items failed"], "failed": failed, "items": failed}
    assert report.selection(many) == (["proof/lane/test_gate.py"], False)
    assert report.selection({**many, "failed": failed[:2]}) == (
        ["proof/lane/test_gate.py::test_0", "proof/lane/test_gate.py::test_1"],
        True,
    )
    # More groups than a lane lists: the rest are counted, and the verdict that names them is named.
    groups = [{**DOCUMENT, "group": f"corpus:d{index}"} for index in range(report.MOST_GROUPS + 3)]
    body = report.body("nightly", "u", "c", [("audit-no-readers", _verdict(False, groups))])
    assert body.count("PROOF_READERS=0 npm run proof --") == report.MOST_GROUPS
    assert "And 3 more groups: the lane's verdict artifact (`proof-lane-verdict-audit-no-readers-<attempt>`" in body


PIECE = {
    "group": "corpus:tile@maximum",
    "why": ["1 of its 1 items failed"],
    "failed": ["checks/pieces.py::test_a_configuration_is_observed_into_the_runs_store[tile@maximum]"],
    "items": ["checks/pieces.py::test_a_configuration_is_observed_into_the_runs_store[tile@maximum]"],
}
FOLLOWER = {
    "group": "corpus:tile",
    "why": [
        "it did not finish: its piece corpus:tile@maximum did not pass, so it was not run: it judges what its pieces"
        " observed, and never observes the document whole in their place"
    ],
    "failed": [],
    "items": DOCUMENT["items"],
}


def test_a_failed_piece_is_named_as_one_with_the_line_that_observes_its_configuration_again():
    body = report.body(
        "nightly", "https://example.test/run/1", "abc123", [("audit", _verdict(True, [PIECE, FOLLOWER]))]
    )
    assert "one configuration of a document that was observed in pieces" in body
    piece, follower = body.split("- `corpus:tile`:")
    assert "- `corpus:tile@maximum`: 1 of its 1 items failed" in piece
    assert (
        "  It is a piece: `corpus:tile` observed under `maximum` alone, for `corpus:tile` to judge, which was not run"
        " without it. The line below observes that configuration again."
    ) in piece
    item = "'proof/checks/pieces.py::test_a_configuration_is_observed_into_the_runs_store[tile@maximum]'"
    assert f"  proof/remote/run.sh <host> -- {item}\n" in piece
    assert "could not be named one by one" not in piece
    # The document's own group names its piece as why, and reruns every item of the document.
    assert "its piece corpus:tile@maximum did not pass, so it was not run" in follower
    assert (
        "  proof/remote/run.sh <host> -- 'proof/checks/test_bar.py::test_every_export_meets_the_bar[tile]'"
        " 'proof/hq/test_branches.py::test_a_documents_branches_hold[tile]'"
    ) in follower
    # A piece that never ran left no item to name: its one item is named from its group alone, a control's too.
    unrun = {"group": "control:tile@minimum", "why": ["no shard's output holds its block"], "failed": [], "items": []}
    assert report.selection(unrun) == (
        ["proof/checks/pieces.py::test_a_configuration_is_observed_into_the_runs_store[control-tile@minimum]"],
        True,
    )
    assert report.selection({**unrun, "group": "corpus:tile"}) == (["proof/checks", "-k", "tile"], False)
    assert report.selection({**unrun, "group": "control:tile"}) == (["proof/checks", "-k", "control-tile"], False)


def test_a_dispatch_over_documents_named_by_hand_is_reported_as_that_and_never_as_a_verdict_on_the_corpus():
    verdict = {**_verdict(True, [], problems=()), "selection": {"documents": ["tile", "list"], "left": ["proof/hq"]}}
    body = report.body(report.MECHANICS, "https://example.test/run/2", "abc123", [("mechanics", verdict)])
    assert body.startswith("A dispatch ran the proof lane over main at `abc123` on documents named by hand")
    assert "It is no verdict on the corpus; the nightly and the weekly are." in body
    assert (
        "It checked the documents named by hand (tile, list) and their controls, and left 1 other group out: it"
        " shows the lane on those documents, and is no verdict on the corpus."
    ) in body
    # It is written whether or not the lane held, and one that held names nothing to rerun.
    assert "Its verdict held." in body and "Rerunning what failed" not in body
    # A failing one names its groups and their lines as any lane's does.
    failed = {**_verdict(True, [PIECE]), "selection": {"documents": ["tile"], "left": []}}
    body = report.body(report.MECHANICS, "https://example.test/run/2", "abc123", [("mechanics", failed)])
    assert "- `corpus:tile@maximum`: 1 of its 1 items failed" in body and "It is a piece" in body
    assert "## Rerunning what failed" in body
