"""What pytest collects of the harness: never a retained tree, and the same items in every process that collects.

Contracts:

- pytest never collects or imports anything under a retained tree
  (``proof/pytest.ini``'s ``norecursedirs``): a test module or a
  ``conftest.py`` under ``hq-apps/`` or ``hq-reads/`` is data HQ made, while
  the harness's own test modules beside it are collected. The plausible
  failure: an adopted tree holding ``test_x.py`` or ``conftest.py``, which
  every later lane would run inside the harness.
- The lane's collection is the same whatever process makes it. The lane's
  server boots HQ and collects, then forks each worker, which collects again
  in the server's memory with its own ``PROOF_OUT`` and ``PROOF_WORKER``, and
  a worker whose items or groups differ from the server's
  (``proof.lane.blocks.collection_digest``) stops the phase before it runs
  anything (``proof.lane.serve``). Two ways a collection follows its process
  are held here: pytest keeps the ids a parametrization's ``ids`` resolved on
  its mark and escapes them again when the same process collects a second
  time, so an id holding a backslash or a character pytest escapes changes in
  every worker; and an id or a parametrization read from a set or dict of
  strings, from ``hash`` or from anything else of the process follows its hash
  seed. A process boots HQ and collects twice, as the server and then a worker
  do, under one hash seed, another boots and collects once under another,
  and the three are one. Over a planted tree holding one id of each kind, the
  same comparison names both, so a comparison that cannot see either fails.
  Where the corpus is not yet in place (a CI shard's early phase, which runs
  this module), the modules whose parametrizations read it fail to collect
  in each process alike and every other module is compared; where it is
  named, every module is, with no collection error.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from proof import processes

PROOF_DIR = Path(__file__).resolve().parent
INI = PROOF_DIR / "pytest.ini"
# What the lane's server collects a phase with (``proof.lane.serve.Server._base_args``), over the whole harness.
LANE_ARGS = ["-c", str(INI), "--rootdir", str(PROOF_DIR), "-o", "console_output_style=classic", str(PROOF_DIR)]
# Two seeds other than the lane's own (``proof/compose.yaml``), so a set's order moves between them.
SEEDS = ("1", "2")


def test_a_retained_tree_is_never_collected_or_imported():
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch) / "proof"
        root.mkdir()
        (root / "test_own.py").write_text("def test_own():\n    pass\n", encoding="utf-8")
        for tree in ("hq-apps/hq-plain", "hq-reads/reading"):
            directory = root / tree
            directory.mkdir(parents=True)
            (directory / "conftest.py").write_text(
                "raise SystemExit('a planted conftest.py was imported')\n", encoding="utf-8"
            )
            (directory / "test_planted.py").write_text("def test_planted():\n    pass\n", encoding="utf-8")
        listing = Path(scratch) / "collected.txt"
        with listing.open("wb") as written:
            status = processes.run(
                [sys.executable, "-m", "pytest", "-c", str(INI), "--rootdir", str(root), "--collect-only", "-q"]
                + [str(root)],
                timeout=120,
                cwd=scratch,
                env={**os.environ, "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "PYTEST_ADDOPTS": ""},
                stdout=written,
                stderr=written,
            )
        collected = listing.read_text(encoding="utf-8")
        assert status == 0, collected
        assert "test_own.py::test_own" in collected
        assert "test_planted" not in collected
        assert "planted conftest.py" not in collected


def collect(destination: str, boots: str, passes: str, *args: str) -> None:
    """Collect ``args`` ``passes`` times in this process, after booting HQ where ``boots`` is ``"boot"``, and write
    each collection's items (node id and group, ``proof.checks.sharding.item_group``) and the node ids that failed
    to collect to ``destination``. Each collection after the first is a forked worker's: the same process, its
    ``PROOF_OUT`` and ``PROOF_WORKER`` its own. Run in a process of its own by ``_collections``."""
    import pytest

    from proof.checks import sharding

    class Collected:
        def __init__(self):
            self.items: dict[str, str] = {}
            self.errors: list[str] = []

        @pytest.hookimpl(trylast=True)
        def pytest_collection_modifyitems(self, session, config, items):
            self.items = {item.nodeid: sharding.item_group(item) for item in items}

        def pytest_collectreport(self, report):
            if report.failed:
                self.errors.append(report.nodeid)

    if boots == "boot":
        from proof.hq import boot

        boot.boot()
    output = Path(destination).parent
    found = []
    for position in range(int(passes)):
        where = output / ("server" if position == 0 else f"workers/w{position + 1}")
        where.mkdir(parents=True, exist_ok=True)
        os.environ["PROOF_OUT"] = str(where)
        os.environ["PROOF_WORKER"] = f"{position + 1}/{passes}"
        collected = Collected()
        pytest.main([*args, "--collect-only", "-qq"], plugins=[collected])
        found.append({"items": sorted(collected.items.items()), "errors": sorted(collected.errors)})
    Path(destination).write_text(json.dumps(found), encoding="utf-8")


def _collections(scratch: Path, args: list[str], *, boots: bool, environment: dict[str, str]) -> dict[str, dict]:
    """The collections of ``args``: two in one process under the first of ``SEEDS``, one under the second, each
    process run by ``collect`` from the checkout's root, keyed by what made it."""
    found = {}
    for seed, passes in zip(SEEDS, ("2", "1"), strict=True):
        directory = scratch / f"seed-{seed}"
        directory.mkdir()
        destination = directory / "collected.json"
        log = directory / "collect.log"
        with log.open("wb") as written:
            status = processes.run(
                [
                    sys.executable,
                    "-c",
                    "import sys; from proof.test_collection import collect; collect(*sys.argv[1:])",
                    str(destination),
                    "boot" if boots else "plain",
                    passes,
                    *args,
                ],
                timeout=600,
                cwd=str(PROOF_DIR.parent),
                env={**environment, "PYTHONHASHSEED": seed},
                stdout=written,
                stderr=written,
            )
        text = log.read_text(encoding="utf-8", errors="replace")
        assert status == 0 and destination.is_file(), f"Collecting under hash seed {seed} failed:\n{text[-4000:]}"
        collections = json.loads(destination.read_text(encoding="utf-8"))
        found[f"seed {seed}, first collection"] = collections[0]
        if passes == "2":
            found[f"seed {seed}, second collection in the same process"] = collections[1]
    return found


def _differences(collections: dict[str, dict]) -> list[str]:
    """Each item or collection error one collection holds and the first does not, or the other way."""
    (first_name, first), *others = collections.items()
    found = []
    for name, other in others:
        for part in ("items", "errors"):
            mine = {json.dumps(entry) for entry in first[part]}
            theirs = {json.dumps(entry) for entry in other[part]}
            found += [f"{part} only in {first_name}: {entry}" for entry in sorted(mine - theirs)]
            found += [f"{part} only in {name}: {entry}" for entry in sorted(theirs - mine)]
    return found


PLANTED = """import pytest


@pytest.mark.parametrize("key", ["home.start", "a\\\\tb"], ids=lambda key: key)
def test_an_id_holding_a_backslash(key):
    pass


@pytest.mark.parametrize("value", [hash("proof")])
def test_an_id_read_from_the_hash_seed(value):
    pass


@pytest.mark.parametrize("key", ["home.start", "modules.m0"], ids=lambda key: key)
def test_a_plain_id(key):
    pass
"""


def test_the_comparison_names_an_id_a_second_collection_escapes_again_and_one_the_hash_seed_moves():
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch) / "planted"
        root.mkdir()
        (root / "test_planted.py").write_text(PLANTED, encoding="utf-8")
        args = ["-c", str(INI), "--rootdir", str(root), str(root)]
        environment = {**os.environ, "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "PYTEST_ADDOPTS": ""}
        collections = _collections(Path(scratch), args, boots=False, environment=environment)
    differences = _differences(collections)
    moved = {entry.split(": ", 1)[1] for entry in differences}
    assert any("test_an_id_holding_a_backslash[a" in entry for entry in moved), differences
    assert any("test_an_id_read_from_the_hash_seed[" in entry for entry in moved), differences
    assert not any("test_a_plain_id" in entry or "home.start" in entry for entry in moved), differences
    for collection in collections.values():
        assert "test_planted.py::test_a_plain_id[modules.m0]" in {node for node, _ in collection["items"]}


def test_every_process_collects_the_lanes_items_alike():
    corpus = os.environ.get("PROOF_CORPUS")
    named = bool(corpus) and Path(corpus, "index.json").is_file()
    with tempfile.TemporaryDirectory() as scratch:
        # A corpus not yet in place is named as one that is not there, so no collection emits one.
        environment = {**os.environ, "PROOF_CORPUS": corpus if named else str(Path(scratch) / "no-corpus")}
        collections = _collections(Path(scratch), LANE_ARGS, boots=True, environment=environment)
    differences = _differences(collections)
    assert not differences, (
        "The harness's collection depends on the process that makes it, so every lane worker's collection differs"
        " from its server's and the lane runs nothing. Give each id below a spelling of printable ASCII with no"
        " backslash, and read no parametrization from a set, a hash or anything else of the process:\n"
        + "\n".join(differences[:40])
    )
    first = next(iter(collections.values()))
    assert first["items"], "The collection holds no item."
    if named:
        assert not first["errors"], f"With the corpus in place, these failed to collect: {first['errors']}"
