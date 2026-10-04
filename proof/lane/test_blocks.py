"""A queue file runs only when it is a lane queue: every block named by its groups, every group run or read once.

Contract (``proof.lane.blocks.parse_queue``): a queue of version 1 whose
blocks each carry the id of their groups (``block_id``), whose groups are
each in one block or cached, never both, with a boolean ``fresh`` and a name
a queue may hold, and none of whose documents is one it names as left out of
its sample (``unsampled``), is read whole; anything else is refused with
every way it is not one, before a shard claims or runs anything. The
plausible failures: a shard running a block under an id its groups do not
give (the gate would then match it against the wrong block), a group run
twice or both run and read from the store, a document both run and named as
left out (the gate would then hold its entries on their controls alone), and
a queue of another version read as this one.

Contract (``proof.lane.blocks.CORPUS_PACKAGES``): the packages listed are
exactly those whose tests read the corpus, so the early phase refuses each
one (``proof.lane.serve``). A package reads it when one of its test modules
or conftests imports, directly or through ``proof``'s own modules, the
corpus's reader (``proof.checks.corpus``, ``proof.checks.cases``) or the
native products' (``proof.native.produce``). The plausible failure: a
package that comes to read the corpus left off the list, so a queue builder
places it in the early queue and each of its tests fails in every shard.
"""

from __future__ import annotations

import ast
import copy
from types import SimpleNamespace

import pytest

from proof.checks import sharding
from proof.lane import blocks as lane_blocks


def _queue():
    return {
        "version": 1,
        "fingerprints": {"observation": "o", "image": "i"},
        "blocks": [
            {
                "id": lane_blocks.block_id(["corpus:a", "proof/hq"]),
                "estimate": 12.5,
                "groups": [{"group": "corpus:a", "fresh": True}, {"group": "proof/hq", "fresh": False}],
            },
            {"id": lane_blocks.block_id(["surface"]), "estimate": 60, "groups": [{"group": "surface", "fresh": False}]},
        ],
        "cached": [{"group": "corpus:b@minimum", "judgments": {"bar": "k1", "proof1": "k2"}}],
    }


def test_a_lane_queue_is_read_whole():
    queue = lane_blocks.parse_queue(_queue())
    assert [block.names for block in queue.blocks] == [("corpus:a", "proof/hq"), ("surface",)]
    assert queue.blocks[0].groups[0] == lane_blocks.QueuedGroup("corpus:a", True)
    assert queue.blocks[1].estimate == 60.0
    assert queue.cached == (lane_blocks.CachedGroup("corpus:b@minimum", {"bar": "k1", "proof1": "k2"}),)
    assert queue.groups() == {"corpus:a", "proof/hq", "surface"}
    assert lane_blocks.parse_queue(lane_blocks.queue_json(queue)) == queue
    assert queue.unsampled == () and "unsampled" not in lane_blocks.queue_json(queue)
    sampled = lane_blocks.parse_queue({**_queue(), "unsampled": ["c", "d"]})
    assert sampled.unsampled == ("c", "d")
    assert lane_blocks.parse_queue(lane_blocks.queue_json(sampled)) == sampled


def _refusal(change):
    value = copy.deepcopy(_queue())
    change(value)
    with pytest.raises(lane_blocks.QueueError) as refused:
        lane_blocks.parse_queue(value, "the test's queue")
    return str(refused.value)


def test_a_queue_of_another_version_is_refused():
    def version(value):
        value["version"] = 2

    assert "its version is 2; this lane reads version 1" in _refusal(version)


def test_a_block_whose_id_is_not_its_groups_id_is_refused():
    def renamed(value):
        value["blocks"][0]["groups"].pop()

    message = _refusal(renamed)
    assert f"block 0's id is {_queue()['blocks'][0]['id']!r}" in message
    assert lane_blocks.block_id(["corpus:a"]) in message


def test_a_group_in_two_blocks_or_both_queued_and_cached_is_refused():
    def twice(value):
        value["blocks"].append(
            {"id": lane_blocks.block_id(["corpus:a"]), "estimate": 1, "groups": [{"group": "corpus:a"}]}
        )

    assert "corpus:a is in block 0 and block 2; a group runs once" in _refusal(twice)

    def queued_and_cached(value):
        value["cached"].append({"group": "surface", "judgments": {}})

    assert "surface is both in block 1 and cached" in _refusal(queued_and_cached)


def test_a_document_both_run_and_left_out_of_the_sample_is_refused():
    def queued(value):
        value["unsampled"] = ["a"]

    assert "corpus:a is run or read, and the queue names its document as one its sample leaves out" in _refusal(queued)

    def cached(value):
        value["unsampled"] = ["b"]

    assert "corpus:b@minimum is run or read" in _refusal(cached)

    def malformed(value):
        value["unsampled"] = "c"

    assert "unsampled documents are not a list of document ids" in _refusal(malformed)


def test_a_fresh_flag_that_is_not_a_boolean_and_a_name_no_queue_holds_are_refused():
    def fresh(value):
        value["blocks"][1]["groups"][0]["fresh"] = "yes"

    assert "surface's fresh is 'yes', not true or false" in _refusal(fresh)

    def nested(value):
        value["blocks"][1]["groups"][0]["group"] = "proof/hq/xpath"

    assert "'proof/hq/xpath' names no package directly under proof/" in _refusal(nested)


# The modules through which a test reads the corpus: its documents, or the native products it carries.
CORPUS_READERS = {"proof.checks.corpus", "proof.checks.cases", "proof.native.produce"}


def _imports(path, name, modules):
    """The modules of ``modules`` that the module ``name`` (at ``path``) imports, anywhere in it."""
    package = name if path.name == "__init__.py" else name.rpartition(".")[0]
    imported = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parent = package.split(".")[: len(package.split(".")) - (node.level - 1)]
                base = ".".join([*parent, *([node.module] if node.module else [])])
            imported.add(base)
            imported.update(f"{base}.{alias.name}" for alias in node.names)
    return {module for module in imported if module in modules}


def test_the_packages_the_early_phase_refuses_are_those_whose_tests_read_the_corpus():
    proof = sharding.PROOF_DIR
    modules = {}
    for path in proof.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        parts = list(path.relative_to(proof.parent).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts.pop()
        modules[".".join(parts)] = path
    graph = {name: _imports(path, name, modules) for name, path in modules.items()}

    def reaches_a_reader(start):
        seen, waiting = set(), [start]
        while waiting:
            name = waiting.pop()
            if name not in seen:
                seen.add(name)
                waiting.extend(graph[name])
        return bool(seen & CORPUS_READERS)

    reading = {
        sharding.item_group(SimpleNamespace(path=path))
        for name, path in modules.items()
        if (path.name.startswith("test_") or path.name == "conftest.py") and reaches_a_reader(name)
    }
    assert sorted(reading) == sorted(lane_blocks.CORPUS_PACKAGES)
    assert all(lane_blocks.reads_corpus(group) for group in reading)
    assert lane_blocks.reads_corpus("corpus:a@minimum") and lane_blocks.reads_corpus("control:a")
    assert not any(lane_blocks.reads_corpus(group) for group in ("proof", "proof/core", "surface", "hq-selfchecks"))
