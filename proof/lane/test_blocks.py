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

Contract (pieces, ``proof.lane.blocks.piece_problems``): a queue a lane is
given holds each piece (``corpus:<id>@<configuration>``, one configuration of
a document observed by a group of its own) in its document's block, with the
document's group following it (``after``); a piece follows nothing, a group
follows only its own document's pieces, and one that follows pieces is never
fresh. The plausible failures: a piece no group reads (a configuration
observed for no one, and its document observed whole beside it), a group
waiting on a piece another shard holds or that no block holds (it would
never be handed out), and a fresh group after its pieces (it would observe
the document again in their place).

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
        "cached": [{"group": "corpus:b", "judgments": {"bar": "k1", "proof1": "k2"}}],
    }


def test_a_lane_queue_is_read_whole():
    queue = lane_blocks.parse_queue(_queue())
    assert [block.names for block in queue.blocks] == [("corpus:a", "proof/hq"), ("surface",)]
    assert queue.blocks[0].groups[0] == lane_blocks.QueuedGroup("corpus:a", True)
    assert queue.blocks[1].estimate == 60.0
    assert queue.cached == (lane_blocks.CachedGroup("corpus:b", {"bar": "k1", "proof1": "k2"}),)
    assert queue.groups() == {"corpus:a", "proof/hq", "surface"}
    assert lane_blocks.parse_queue(lane_blocks.queue_json(queue)) == queue
    assert queue.unsampled == () and "unsampled" not in lane_blocks.queue_json(queue)
    sampled = lane_blocks.parse_queue({**_queue(), "unsampled": ["c", "d"]})
    assert sampled.unsampled == ("c", "d")
    assert lane_blocks.parse_queue(lane_blocks.queue_json(sampled)) == sampled
    # A sampled queue names the documents its sample kept and the seed that chose them.
    assert queue.sample is None and "sample" not in lane_blocks.queue_json(queue)
    seeded = lane_blocks.parse_queue({**_queue(), "sample": {"seed": "2026-W42", "documents": ["a"]}})
    assert seeded.sample == lane_blocks.Sample(("a",), "2026-W42")
    assert lane_blocks.parse_queue(lane_blocks.queue_json(seeded)) == seeded
    assert lane_blocks.parse_queue({**_queue(), "sample": {"seed": None, "documents": ["a"]}}).sample.seed is None


def test_a_run_over_documents_named_by_hand_names_them_and_what_it_leaves_out():
    value = {**_queue(), "selection": {"documents": ["a"], "left": ["control:z", "proof/checks"]}}
    queue = lane_blocks.parse_queue(value)
    assert queue.selection == lane_blocks.Selection(("a",), ("control:z", "proof/checks"))
    assert lane_blocks.parse_queue(lane_blocks.queue_json(queue)) == queue
    assert lane_blocks.parse_queue(_queue()).selection is None and "selection" not in lane_blocks.queue_json(
        lane_blocks.parse_queue(_queue())
    )
    for broken, why in (
        ({"documents": "a"}, "its selection names no list of document ids"),
        ({"documents": ["a"], "left": "x"}, "its selection's left is not a list of the groups it leaves out"),
        ({"documents": ["a"], "left": ["proof/hq"]}, "proof/hq is run or read, and the selection names it as left out"),
    ):
        with pytest.raises(lane_blocks.QueueError, match=why):
            lane_blocks.parse_queue({**_queue(), "selection": broken})


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

    assert "corpus:b is run or read" in _refusal(cached)

    def malformed(value):
        value["unsampled"] = "c"

    assert "unsampled documents are not a list of document ids" in _refusal(malformed)

    def unnamed(value):
        value["sample"] = {"seed": "2026-W42"}

    assert "its sample names no list of document ids" in _refusal(unnamed)

    def unseeded(value):
        value["sample"] = {"seed": 42, "documents": ["a"]}

    assert "its sample's seed is 42" in _refusal(unseeded)


def test_a_fresh_flag_that_is_not_a_boolean_and_a_name_no_queue_holds_are_refused():
    def fresh(value):
        value["blocks"][1]["groups"][0]["fresh"] = "yes"

    assert "surface's fresh is 'yes', not true or false" in _refusal(fresh)

    def nested(value):
        value["blocks"][1]["groups"][0]["group"] = "proof/hq/xpath"

    assert "'proof/hq/xpath' names no test module of a package (proof/<package>/<module>.py)" in _refusal(nested)

    def split(value):
        value["blocks"][1]["groups"][0]["group"] = "proof/hq/test_boot.py::"

    assert "'proof/hq/test_boot.py::' names no test module of a package" in _refusal(split)


def _pieces(*, fresh=True):
    """A queue of one document in pieces with a control beside it: each configuration a group, the document's own
    group after them."""
    groups = [
        {"group": "corpus:a@maximum", "fresh": fresh, "estimate": 60.0},
        {"group": "corpus:a@minimum", "fresh": fresh, "estimate": 40.0},
        {"group": "corpus:a", "fresh": False, "after": ["corpus:a@maximum", "corpus:a@minimum"], "estimate": 2.0},
        {"group": "control:a", "fresh": fresh},
    ]
    identifier = lane_blocks.block_id(group["group"] for group in groups)
    return {"version": 1, "blocks": [{"id": identifier, "estimate": 110.0, "groups": groups}], "cached": []}


def _piece_refusal(change):
    value = _pieces()
    change(value["blocks"][0]["groups"])
    value["blocks"][0]["id"] = lane_blocks.block_id(group["group"] for group in value["blocks"][0]["groups"])
    with pytest.raises(lane_blocks.QueueError) as refused:
        lane_blocks.parse_queue(value, "the test's queue")
    return str(refused.value)


def test_a_document_in_pieces_is_read_with_the_group_that_follows_them_and_written_back_the_same():
    queue = lane_blocks.parse_queue(_pieces())
    whole = next(group for group in queue.blocks[0].groups if group.group == "corpus:a")
    assert whole == lane_blocks.QueuedGroup("corpus:a", False, ("corpus:a@maximum", "corpus:a@minimum"), 2.0)
    piece = next(group for group in queue.blocks[0].groups if group.group == "corpus:a@maximum")
    assert piece == lane_blocks.QueuedGroup("corpus:a@maximum", True, (), 60.0)
    assert lane_blocks.piece_of("corpus:a@maximum") == ("corpus:a", "maximum")
    assert lane_blocks.piece_of("control:a@minimum") == ("control:a", "minimum")
    assert lane_blocks.piece_of("corpus:a") is None and lane_blocks.piece_of("proof/hq") is None
    # A group that follows nothing and carries no estimate is written as it always was.
    written = lane_blocks.queue_json(queue)
    assert written["blocks"][0]["groups"][3] == {"group": "control:a", "fresh": True}
    assert lane_blocks.parse_queue(written) == queue
    # A control is observed in pieces as a document is.
    control = _pieces()
    for group in control["blocks"][0]["groups"][:3]:
        group["group"] = group["group"].replace("corpus:a", "control:b")
    control["blocks"][0]["groups"][2]["after"] = ["control:b@maximum", "control:b@minimum"]
    control["blocks"][0]["id"] = lane_blocks.block_id(group["group"] for group in control["blocks"][0]["groups"])
    assert lane_blocks.parse_queue(control).blocks[0].groups[2].after == ("control:b@maximum", "control:b@minimum")


def test_a_piece_no_group_follows_and_a_group_following_what_is_not_its_piece_are_refused():
    def unfollowed(groups):
        groups[2]["after"] = ["corpus:a@maximum"]

    assert "the piece corpus:a@minimum is followed by no group" in _piece_refusal(unfollowed)

    def alone(groups):
        del groups[2]

    message = _piece_refusal(alone)
    assert "the piece corpus:a@maximum is followed by no group: corpus:a, which judges what it observes" in message

    def elsewhere(groups):
        groups[2]["after"].append("corpus:a@other")

    assert "corpus:a follows corpus:a@other, which is not in its block" in _piece_refusal(elsewhere)

    def anothers(groups):
        groups[3]["after"] = ["corpus:a@maximum"]

    assert "control:a follows corpus:a@maximum, which is no piece of it" in _piece_refusal(anothers)

    def chained(groups):
        groups[1]["after"] = ["corpus:a@maximum"]

    assert "the piece corpus:a@minimum follows corpus:a@maximum; a piece follows nothing" in _piece_refusal(chained)

    def twice(groups):
        groups[2]["after"].append("corpus:a@maximum")

    assert "corpus:a names a piece twice in its after" in _piece_refusal(twice)

    def fresh(groups):
        groups[2]["fresh"] = True

    assert "corpus:a follows its pieces and is fresh; it reads what they observed" in _piece_refusal(fresh)

    def malformed(groups):
        groups[2]["after"] = "corpus:a@maximum"

    assert "corpus:a's after is 'corpus:a@maximum', not a list of the pieces it follows" in _piece_refusal(malformed)

    def unnamed(groups):
        groups[0]["group"] = "corpus:a@"

    assert "'corpus:a@' names no one configuration of its document" in _piece_refusal(unnamed)

    def costed(groups):
        groups[0]["estimate"] = "long"

    assert "corpus:a@maximum's estimate is 'long', not a number of box-seconds" in _piece_refusal(costed)

    cached = _pieces()
    cached["cached"] = [{"group": "corpus:c@minimum", "judgments": {}}]
    with pytest.raises(lane_blocks.QueueError, match="the cached group corpus:c@minimum is a piece; a piece observes"):
        lane_blocks.parse_queue(cached)


def test_the_queue_a_run_writes_for_itself_may_hold_a_piece_alone():
    """A person who observes one configuration again names the piece's item, and the server writes the queue of
    what it collected (``check_names`` off): the gate reads that queue for the slice."""
    queue = lane_blocks.single_block({"corpus:a@maximum": 60.0})
    value = lane_blocks.queue_json(queue)
    assert lane_blocks.parse_queue(value, check_names=False).groups() == {"corpus:a@maximum"}
    with pytest.raises(lane_blocks.QueueError, match="the piece corpus:a@maximum is followed by no group"):
        lane_blocks.parse_queue(value)


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
        lane_blocks.package_of(sharding.item_group(SimpleNamespace(path=path)))
        for name, path in modules.items()
        if (path.name.startswith("test_") or path.name == "conftest.py") and reaches_a_reader(name)
    }
    assert sorted(reading) == sorted(lane_blocks.CORPUS_PACKAGES)
    assert all(lane_blocks.reads_corpus(group) for group in reading)
    assert lane_blocks.reads_corpus("corpus:a@minimum") and lane_blocks.reads_corpus("control:a")
    assert not any(lane_blocks.reads_corpus(group) for group in ("proof", "proof/core", "surface", "hq-selfchecks"))
