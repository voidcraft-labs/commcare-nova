"""The queues run what the store cannot stand for, read the rest from it, and are the same bytes for the same inputs.

Contract (``proof.store.queue``): over a store packed from an earlier run
of the same checkout, a document whose files are unchanged and whose every
check passed is cached (with each judgment's key and its outcome's); one
whose records are held but not a passing outcome is judged; one whose files
changed is observed, and so is everything in a cold run. A package keyed on
a sample of the corpus stays cached while its sample is unchanged, and the
sample is the only place its tests read the corpus. Documents whose record
parts share inputs go into one block, unless dedupe is off; blocks are
packed longest first. The audit sample is chosen by the seed alone, holds
the number of (document, configuration) units asked for, and always runs.
The early queue holds no group that reads the corpus, the main queue holds
every document, the controls the register names, and the packages that read
the corpus; ``sample:N`` keeps N documents in the corpus the lane collects,
and the queue names the documents it leaves out. The same inputs write the
same bytes.

An edit of the browser's code alone leaves no document cached or judged:
proof 4's parts name that code, and the queue reads a document's parts
under its key alone. A group is cached only where the store gives every
blob the gate will read for it whole (each judgment, the surface block's
extraction), and judged only where it holds every part the document entry
names with the record digest it names; a damaged or missing one is a miss.

The plausible failures: a cached document whose edit the queue missed (its
key reads too little of its files), a judged document queued as cached
because its records are held, a document cached over the browser's old code
(proof 4 never driven again, its stale judgment held to the register), a
group cached over a damaged judgment (the gate then cannot read it), a
document judged over a part the store no longer holds as named, a package
cached over a sample its tests no longer keep to, a block split between two
documents that share a part (so neither reads the other's), an audit sample
that changes between two builds of one run, and an early queue that holds a
group the early phase cannot run.
"""

from __future__ import annotations

import ast
import json
import shutil

import pytest

from proof.checks.corpus import Document
from proof.lane import blocks as lane_blocks
from proof.observe import unit
from proof.store import disk, fingerprints, pack, queue, runtime
from proof.store.conftest import (
    copied_control,
    document_of,
    observe_into,
    records_of,
    write_block,
    write_files,
    write_inputs,
)
from proof.store.test_runtime import _environ


def _build(checkout, out, *arguments, corpus=None, phase="main", stores=()):
    argv = [phase, "--root", str(checkout), "--arch", "arm64", "--out", str(out)]
    argv += ["--timings", str(checkout / "proof" / "timings.json")]
    if corpus is not None:
        argv += ["--corpus", str(corpus)]
    for store in stores:
        argv += ["--store", str(store)]
    assert queue.main([*argv, *arguments]) == 0
    return json.loads(out.read_text())


@pytest.fixture
def lane(checkout, corpus):
    timings = {"groups": {"corpus:one": 4.0, "corpus:two": 6.0, "proof/checks": 9.0, "proof/core": 2.0}}
    write_files(checkout, {"proof/timings.json": json.dumps(timings)})
    return checkout, corpus


def _ran(checkout, corpus, output, queue_path, *, failing=()):
    """A lane run of the queue: each document and control observed through the store, every group's items and
    evidence."""
    found = fingerprints.compute(checkout, arch="arm64")
    environ = _environ(output)
    environ["PROOF_FINGERPRINTS"] = json.dumps(found)
    groups, evidence = {}, {}
    value = json.loads(queue_path.read_text())
    for block in value["blocks"]:
        for queued in block["groups"]:
            name = queued["group"]
            outcome = "failed" if name in failing else "passed"
            groups[name] = {f"{name}::test": outcome}
            kind, _, identifier = name.partition(":")
            if kind in ("corpus", "control"):
                document = document_of(corpus, identifier) if kind == "corpus" else _control(checkout, identifier)
                observe_into(runtime.session_store(document, environ), document, records_of(document))
                evidence[("bar", name)] = []
    write_block(output, groups, evidence)
    return output


def test_a_store_of_an_earlier_run_caches_what_is_unchanged_and_runs_what_its_keys_miss(tmp_path, lane):
    checkout, corpus = lane
    cold = _build(checkout, tmp_path / "cold.json", corpus=corpus)
    packages = ["proof/checks", "proof/editors"]
    assert cold["classes"] == {"cached": [], "judged": [], "observed": ["corpus:one", "corpus:two", *packages]}
    assert all(lane_blocks.parse_queue(cold).blocks)
    output = _ran(checkout, corpus, tmp_path / "out", tmp_path / "cold.json", failing={"corpus:two"})
    store = pack.write(pack.gather([output], [tmp_path / "cold.json"]), tmp_path / "store")

    warm = _build(checkout, tmp_path / "warm.json", corpus=corpus, stores=[store, tmp_path / "absent"])
    assert warm["classes"] == {"cached": ["corpus:one", *packages], "judged": ["corpus:two"], "observed": []}
    cached = {entry["group"]: entry["judgments"] for entry in warm["cached"]}
    assert set(cached["corpus:one"]) == {"bar", "outcome"} and set(cached["proof/checks"]) == {"outcome"}
    assert [g["group"] for b in warm["blocks"] for g in b["groups"]] == ["corpus:two"]
    assert warm["blocks"][0]["estimate"] == round(6.0 * queue.JUDGED_SHARE, 3)

    # An edit of the judge's code leaves the records held: each document is judged again, and the packages run.
    judge = checkout / "proof" / "checks" / "bar.py"
    original = judge.read_text()
    judge.write_text('"""a judge, edited"""\n')
    judged = _build(checkout, tmp_path / "judged.json", corpus=corpus, stores=[store])
    assert judged["classes"] == {"cached": [], "judged": ["corpus:one", "corpus:two"], "observed": packages}
    judge.write_text(original)
    # An edit of one document's export misses its key: it is observed, and so is the package reading every
    # document; the package keyed on its sample (two) stays cached.
    body = corpus / "one" / "export" / "minimum" / "create.body"
    body.write_text(body.read_text() + " edited")
    write_inputs(corpus / "one")
    edited = _build(checkout, tmp_path / "edited.json", corpus=corpus, stores=[store])
    assert edited["classes"] == {
        "cached": ["proof/editors"],
        "judged": ["corpus:two"],
        "observed": ["corpus:one", "proof/checks"],
    }
    # An edit of the sample's document misses that package's key too.
    body = corpus / "two" / "export" / "minimum" / "create.body"
    body.write_text(body.read_text() + " edited")
    write_inputs(corpus / "two")
    sampled = _build(checkout, tmp_path / "sampled.json", corpus=corpus, stores=[store])
    assert sampled["classes"]["observed"] == ["corpus:one", "corpus:two", *packages]
    # --fresh reads nothing from the store.
    fresh = _build(checkout, tmp_path / "fresh.json", "--fresh", corpus=corpus, stores=[store])
    assert fresh["cached"] == [] and fresh["fresh"] == ["corpus:one", "corpus:two", *packages]


def _control(checkout, identifier):
    """The control ``identifier`` of the checkout, read afresh as the lane reads one."""
    return Document(id=identifier, source="control", root=checkout / "proof" / "controls" / identifier, kind="control")


def test_a_control_is_kept_and_read_back_under_its_own_files_as_a_document_is(tmp_path, lane):
    checkout, corpus = lane
    control = copied_control(checkout / "proof" / "controls")
    register = [{"id": "d1", "check": "bar", "document": "one", "control": control.id}]
    (checkout / "proof" / "known-defects.json").write_text(json.dumps(register))
    name = control.group
    assert queue.configurations_of(control.root) == len(control.exports) > 1
    cold = _build(checkout, tmp_path / "cold.json", corpus=corpus)
    assert name in cold["classes"]["observed"]
    output = _ran(checkout, corpus, tmp_path / "out", tmp_path / "cold.json")
    # The run kept the control's document entry, under its files, naming each part its observation kept.
    entries = [e for e in disk.Delta(output / disk.DELTA).entries("documents").values() if e["group"] == name]
    assert len(entries) == 1 and set(entries[0]["parts"]) == {"minimum/a", "minimum/b", "minimum/b_edit", "local"}
    store = pack.write(pack.gather([output], [tmp_path / "cold.json"]), tmp_path / "store")

    warm = _build(checkout, tmp_path / "warm.json", corpus=corpus, stores=[store])
    assert name in warm["classes"]["cached"]
    assert set(next(e["judgments"] for e in warm["cached"] if e["group"] == name)) == {"bar", "outcome"}
    # An edit of the judge's code leaves its records held: it is judged again, as a document is.
    judge = checkout / "proof" / "checks" / "bar.py"
    original = judge.read_text()
    judge.write_text('"""a judge, edited"""\n')
    assert name in _build(checkout, tmp_path / "judged.json", corpus=corpus, stores=[store])["classes"]["judged"]
    judge.write_text(original)
    # An edit of any one of its files misses its key, and the record keys its files give miss the store: it is
    # observed again. As it was, it is cached again.
    for relative in ("export/minimum/create.body", "derived.json", "configurations.json", "verdict.json"):
        path = control.root / relative
        original = path.read_bytes()
        path.write_bytes(original + b"\n")
        try:
            found = _build(checkout, tmp_path / "edited.json", corpus=corpus, stores=[store])["classes"]
            edited = records_of(_control(checkout, control.id))
        finally:
            path.write_bytes(original)
        assert name in found["observed"], relative
        reading = runtime.session_store(control, _environ(tmp_path / "reading", store=store))
        assert reading.lookup(edited.configurations["minimum"].keys["a"]) is None, relative
    assert name in _build(checkout, tmp_path / "again.json", corpus=corpus, stores=[store])["classes"]["cached"]


def test_an_edit_of_the_browsers_code_alone_leaves_no_document_cached(tmp_path, lane):
    checkout, corpus = lane
    _build(checkout, tmp_path / "cold.json", corpus=corpus)
    output = _ran(checkout, corpus, tmp_path / "out", tmp_path / "cold.json")
    store = pack.write(pack.gather([output], [tmp_path / "cold.json"]), tmp_path / "store")
    assert _build(checkout, tmp_path / "warm.json", corpus=corpus, stores=[store])["classes"]["cached"] == [
        "corpus:one",
        "corpus:two",
        "proof/checks",
        "proof/editors",
    ]
    driver = checkout / "proof" / "editors" / "driver" / "driver.mjs"
    driver.write_text(driver.read_text() + "// a changed browser step\n")
    edited = _build(checkout, tmp_path / "edited.json", corpus=corpus, stores=[store])
    assert edited["classes"] == {
        "cached": [],
        "judged": [],
        "observed": ["corpus:one", "corpus:two", "proof/checks", "proof/editors"],
    }


def _variant(store, name, change):
    """A copy of the snapshot ``store`` with ``change(copy, index)`` made to it (the index written back)."""
    copy = store.parent / name
    shutil.copytree(store, copy)
    index = json.loads((copy / "index.json").read_text())
    change(copy, index)
    (copy / "index.json").write_text(json.dumps(index))
    return copy


def _document_parts(store, identifier):
    """The record digests the snapshot's entry for a document names, by part."""
    index = json.loads((store / "index.json").read_text())
    entry = next(entry for entry in index["documents"].values() if entry["group"] == f"corpus:{identifier}")
    return {part: held for part, (_, held) in entry["parts"].items()}


def test_a_group_is_cached_only_where_the_store_gives_whole_what_the_gate_reads_and_judged_only_over_its_parts(
    tmp_path, lane
):
    checkout, corpus = lane
    _build(checkout, tmp_path / "cold.json", corpus=corpus)
    output = _ran(checkout, corpus, tmp_path / "out", tmp_path / "cold.json")
    early = _build(checkout, tmp_path / "early.json", phase="early")
    assert sorted(g["group"] for b in early["blocks"] for g in b["groups"]) == ["proof/core", "surface"]
    ran_early = tmp_path / "early-out"
    block = write_block(ran_early, {"surface": {"surface::test": "passed"}, "proof/core": {"core::test": "passed"}})
    write_files(block, {"surface/surface.json": '{"items": []}\n'})
    queues = [tmp_path / "cold.json", tmp_path / "early.json"]
    store = pack.write(pack.gather([output, ran_early], queues), tmp_path / "stores" / "whole")
    assert _build(checkout, tmp_path / "w.json", corpus=corpus, stores=[store])["classes"]["cached"] == [
        "corpus:one",
        "corpus:two",
        "proof/checks",
        "proof/editors",
    ]
    assert _build(checkout, tmp_path / "e.json", phase="early", stores=[store])["classes"]["cached"] == [
        "proof/core",
        "surface",
    ]

    # A damaged judgment of one's: one's checks are judged again, two stays cached.
    one = _document_parts(store, "one")

    def damage_judgments(copy, index):
        judged = next(o for o in index["groups"].values() if o["group"] == "corpus:one")
        for key in judged["judgments"].values():
            disk.blob_path(copy, index["judgments"][key]).write_bytes(b"damaged")

    damaged = _variant(store, "judgments", damage_judgments)
    found = _build(checkout, tmp_path / "j.json", corpus=corpus, stores=[damaged])["classes"]
    assert (found["judged"], "corpus:two" in found["cached"]) == (["corpus:one"], True)
    # A damaged extraction: the surface block runs again, the other early package stays cached.

    def damage_surface(copy, index):
        outcome = next(o for o in index["groups"].values() if o["group"] == "surface")
        disk.blob_path(copy, outcome["surface"]).write_bytes(b"damaged")

    found = _build(checkout, tmp_path / "s.json", phase="early", stores=[_variant(store, "surface", damage_surface)])
    assert found["classes"] == {"cached": ["proof/core"], "judged": [], "observed": ["surface"]}

    # A part the document entry names that the store no longer holds (its record's blob gone, so the merged store
    # drops it), or holds as another record: the document is observed.
    def drop_record(copy, index):
        disk.blob_path(copy, one["minimum/a"]).unlink()

    def other_record(copy, index):
        held = next(entry for entry in index["parts"].values() if entry["record"] == one["minimum/a"])
        held["record"] = one["local"]

    for name, change in (("dropped", drop_record), ("other", other_record)):
        found = _build(checkout, tmp_path / f"{name}.json", corpus=corpus, stores=[_variant(store, name, change)])
        assert "corpus:one" in found["classes"]["observed"], name
        assert "corpus:two" in found["classes"]["cached"], name


def test_the_same_inputs_write_the_same_queue_and_the_seed_alone_chooses_the_audit_sample(tmp_path, lane):
    checkout, corpus = lane
    first = _build(checkout, tmp_path / "first.json", "--audit-seed", "17", "--audit-units", "1", corpus=corpus)
    second = _build(checkout, tmp_path / "second.json", "--audit-seed", "17", "--audit-units", "1", corpus=corpus)
    assert (tmp_path / "first.json").read_bytes() == (tmp_path / "second.json").read_bytes()
    assert len(first["fresh"]) == 1 and first["fresh"][0].startswith("corpus:")
    # A document of the sample runs observed, at what observing it costs, though the store held it.
    groups = [queue.Group("corpus:a", 6.0, units=2), queue.Group("corpus:b", 4.0, units=2)]
    groups[0].status, groups[0].estimate, groups[1].status = "judged", 1.2, "cached"
    queue.audit_sample(groups, "17", 4)
    assert [(g.status, g.estimate, g.fresh) for g in groups] == [("observed", 6.0, True), ("observed", 4.0, True)]
    # The sample is counted in (document, configuration) units: documents of two configurations, two per four.
    many = [queue.Group(f"corpus:{n}", 1.0, units=2) for n in range(10)] + [queue.Group("proof/checks", 9.0)]
    queue.audit_sample(many, "17", queue.AUDIT_UNITS)
    assert sum(g.fresh for g in many) == queue.AUDIT_UNITS // 2 and not many[-1].fresh
    chosen = {
        tuple(
            _build(checkout, tmp_path / f"seed-{seed}.json", "--audit-seed", seed, "--audit-units", "1", corpus=corpus)[
                "fresh"
            ]
        )
        for seed in ("1", "2", "3", "4", "5", "6")
    }
    assert len(chosen) == 2
    # Blocks are listed longest first, each named by its groups.
    estimates = [block["estimate"] for block in second["blocks"]]
    assert estimates == sorted(estimates, reverse=True)
    for block in second["blocks"]:
        assert block["id"] == lane_blocks.block_id(group["group"] for group in block["groups"])


def test_documents_sharing_a_parts_inputs_share_a_block_unless_dedupe_is_off(tmp_path, lane):
    checkout, corpus = lane
    shutil.copytree(corpus / "one", corpus / "copy")
    write_inputs(corpus / "copy")
    index = json.loads((corpus / "index.json").read_text())
    index["documents"].append({"id": "copy"})
    (corpus / "index.json").write_text(json.dumps(index))

    def holding(value, name):
        return next(
            tuple(g["group"] for g in block["groups"])
            for block in value["blocks"]
            if any(g["group"] == name for g in block["groups"])
        )

    deduped = _build(checkout, tmp_path / "deduped.json", corpus=corpus)
    assert holding(deduped, "corpus:copy") == ("corpus:copy", "corpus:one")
    apart = _build(checkout, tmp_path / "apart.json", "--no-dedupe", corpus=corpus)
    assert "corpus:one" not in holding(apart, "corpus:copy")


def test_the_early_queue_reads_no_corpus_and_the_main_queue_holds_what_reads_it(tmp_path, lane):
    checkout, corpus = lane
    early = _build(checkout, tmp_path / "early.json", phase="early")
    names = [group["group"] for block in early["blocks"] for group in block["groups"]]
    assert sorted(names) == ["proof/core", "surface"]
    assert not any(lane_blocks.reads_corpus(name) for name in names)
    # A control the register names is its own group, beside the corpus's documents.
    write_files(checkout, {"proof/controls/defect-1/document.json": "{}"})
    (checkout / "proof" / "known-defects.json").write_text(json.dumps([{"id": "d1", "control": "defect-1"}]))
    main = _build(checkout, tmp_path / "main.json", corpus=corpus)
    assert sorted(main["classes"]["observed"]) == [
        "control:defect-1",
        "corpus:one",
        "corpus:two",
        "proof/checks",
        "proof/editors",
    ]
    # sample:N keeps N documents in the corpus the lane collects, and queues those alone; it lists the others as
    # the sample leaves them out, and the queue names them for the gate (a whole corpus's queue names none).
    assert "unsampled" not in main
    sampled = _build(checkout, tmp_path / "sampled.json", "--documents", "sample:1", corpus=corpus)
    index = json.loads((corpus / "index.json").read_text())
    kept = [entry["id"] for entry in index["documents"]]
    assert len(kept) == 1 and f"corpus:{kept[0]}" in sampled["classes"]["observed"]
    assert sum(name.startswith("corpus:") for name in sampled["classes"]["observed"]) == 1
    left = sorted({"one", "two"} - set(kept))
    assert [entry["id"] for entry in index["unsampled"]] == left and sampled["unsampled"] == left
    assert queue.main(["early", "--documents", "sample:1", "--out", str(tmp_path / "x.json")]) == 2


# The modules through which a test reads the corpus: its documents, or the native products it carries.
CORPUS_READERS = frozenset({"proof.checks.cases", "proof.checks.corpus", "proof.native.produce"})


def _reads_corpus(path) -> bool:
    """Whether a test module imports a corpus reader itself (anywhere in it)."""
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import) and any(alias.name in CORPUS_READERS for alias in node.names):
            return True
        if isinstance(node, ast.ImportFrom) and node.module:
            named = {node.module, *(f"{node.module}.{alias.name}" for alias in node.names)}
            if named & CORPUS_READERS:
                return True
    return False


def test_a_package_keyed_on_a_sample_reads_the_corpus_only_where_it_names_the_sample():
    root = fingerprints.WORKTREE
    for name, data in sorted(queue.PACKAGE_DATA.items()):
        sample = data.get("documents")
        if sample in (None, queue.EVERY):
            continue
        module, constant = sample
        assert queue.declared_documents(root, module, constant), f"{module} names no documents in {constant}."
        readers = {
            path.relative_to(root).as_posix()
            for path in sorted((root / name).rglob("*.py"))
            if (path.name.startswith("test_") or path.name == "conftest.py") and _reads_corpus(path)
        }
        native = {path for path in readers if "proof.native" in (root / path).read_text(encoding="utf-8")}
        assert readers - native == {module}, name
        assert not native or data.get("native") == queue.EVERY, name


def test_the_queue_reads_b_edits_unread_roles_as_the_observation_does():
    assert queue.B_UNREAD == unit.B_UNREAD_ROLES
