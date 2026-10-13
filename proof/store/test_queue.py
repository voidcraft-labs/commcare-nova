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

A document or control that is observed, is exported under more than one
configuration, and whose whole measure on one worker is past the split
threshold (the profile's, or ``--split-above``) is queued in pieces: each
configuration a group of its own with its own estimate, and the document's
own group after them in the same block, never fresh, at what judging costs.
A document the store holds the records of, one under a single
configuration, and every document where no threshold is named are queued
whole. A document measured in pieces is measured whole by its pieces' sum
with its own group's.

The plausible failures: a cached document whose edit the queue missed (its
key reads too little of its files), a judged document queued as cached
because its records are held, a document cached over the browser's old code
(proof 4 never driven again, its stale judgment held to the register), a
group cached over a damaged judgment (the gate then cannot read it), a
document judged over a part the store no longer holds as named, a package
cached over a sample its tests no longer keep to, a block split between two
documents that share a part (so neither reads the other's), an audit sample
that changes between two builds of one run, an early queue that holds a
group the early phase cannot run, a document's pieces in another block than
its own group (another shard would run them, and its own group would never
find what they kept), a judged document split (its pieces would observe what
the store already holds), a document measured in pieces read as light by its
own group's measure and queued whole, and a fresh group after its pieces
(observing the document again in their place).
"""

from __future__ import annotations

import ast
import json
import shutil

import pytest

from proof.checks.corpus import Document
from proof.lane import blocks as lane_blocks
from proof.lane import readers as lane_readers
from proof.observe import unit
from proof.store import disk, fingerprints, pack, queue, runtime
from proof.store.conftest import (
    copied_control,
    document_of,
    observe_into,
    records_of,
    write_block,
    write_corpus,
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
def lane(checkout, corpus, monkeypatch):
    # The synthetic checkout's packages run whole: the lane's own splits name modules of the real one
    # (proof.checks.sharding.SPLIT), and the test of splitting names its own.
    from proof.checks import sharding

    monkeypatch.setattr(sharding, "SPLIT", {})
    groups = {"corpus:one": 4.0, "corpus:two": 6.0, "proof/checks": 9.0, "proof/core": 2.0}
    timings = {"profiles": {"readers": {"groups": groups}, "no-readers": {"groups": groups}}}
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

    # The copy measured as its sibling is, so only the shared inputs, never its estimate, put the two together.
    timings = json.loads((checkout / "proof" / "timings.json").read_text())
    for profile in timings["profiles"].values():
        profile["groups"]["corpus:copy"] = profile["groups"]["corpus:two"]
    write_files(checkout, {"proof/timings.json": json.dumps(timings)})
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


def test_a_seeded_sample_is_its_weeks_window_so_every_document_has_its_week(tmp_path, lane, monkeypatch, capsys):
    """``--sample-seed`` (an ISO year and week): each week checks the next window of the corpus's documents, the
    same seed the same sample, and the queue and the job's summary name the seed and the sample."""
    checkout, _ = lane
    documents = {name: {"create": name} for name in ("a", "b", "c", "d", "e")}
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))

    def sample(seed, name):
        corpus = write_corpus(tmp_path / name, documents)
        arguments = ["--documents", "sample:2", *(["--sample-seed", seed] if seed else [])]
        return _build(checkout, tmp_path / f"{name}.json", *arguments, corpus=corpus)

    # Five documents in samples of two: three windows, so any three weeks in a row check every document, across
    # a year's end as within it; the last window wraps, so each sample holds two.
    weeks = ["2026-W52", "2026-W53", "2027-W01", "2027-W02"]
    found = [sample(seed, f"week-{index}") for index, seed in enumerate(weeks)]
    kept = [value["sample"]["documents"] for value in found]
    assert all(len(names) == 2 for names in kept)
    assert set(kept[0] + kept[1] + kept[2]) == set(documents) == set(kept[1] + kept[2] + kept[3])
    assert kept[3] == kept[0] and kept[0] != kept[1]
    assert [value["sample"]["seed"] for value in found] == weeks
    assert sorted(kept[0] + found[0]["unsampled"]) == sorted(documents)
    # The same seed gives the same sample again; no seed, the ranking's first window, whatever the week.
    assert sample("2026-W53", "again")["sample"] == found[1]["sample"]
    unseeded = sample(None, "unseeded")["sample"]
    assert unseeded["seed"] is None and unseeded["documents"] == sample(None, "unseeded-again")["sample"]["documents"]
    # The queue is one the lane reads, and the builder says the seed and the sample where the job's summary is.
    assert lane_blocks.parse_queue(found[0]).sample == lane_blocks.Sample(tuple(kept[0]), "2026-W52")
    said = summary.read_text()
    listed = ", ".join(kept[0])
    assert (
        f"the one the seed `2026-W52` chooses (`--sample-seed 2026-W52` runs the same sample again): {listed}." in said
    )
    assert "This run checks a sample of 2 of the corpus's 5 documents" in said

    # A seed that names no ISO week, or one with no sample to choose, is refused.
    capsys.readouterr()
    corpus = write_corpus(tmp_path / "refused", documents)
    base = ["main", "--root", str(checkout), "--arch", "arm64", "--corpus", str(corpus), "--out", str(tmp_path / "x")]
    assert queue.main([*base, "--documents", "sample:2", "--sample-seed", "2026-W54"]) == 2
    assert "--sample-seed names the ISO year and week" in capsys.readouterr().err
    assert queue.main([*base, "--sample-seed", "2026-W42"]) == 2
    assert "--documents names no sample" in capsys.readouterr().err


def test_a_queue_without_the_readers_holds_nothing_only_a_reader_runs_and_keys_the_rest_apart(tmp_path, lane):
    """``--lane-env PROOF_READERS=0`` (proof.lane.readers): no package every test of which starts a reader, no
    control only the served readers' entries name, every key that profile's, and the queue says so."""
    checkout, corpus = lane
    write_files(
        checkout,
        {
            "proof/connect/test_receiver.py": "def test_receiver():\n    pass\n",
            "proof/controls/plain/document.json": "{}",
            "proof/controls/reader/document.json": "{}",
        },
    )
    register = [
        {"id": "d1", "control": "plain", "artifact": "upload"},
        {"id": "d2", "control": "reader", "artifact": "formplayer@B"},
        {"id": "d3", "control": "reader", "artifact": "android-tablet@vellum@*"},
    ]
    (checkout / "proof" / "known-defects.json").write_text(json.dumps(register))
    every = _build(checkout, tmp_path / "every.json", corpus=corpus)
    without = _build(checkout, tmp_path / "without.json", "--lane-env", "PROOF_READERS=0", corpus=corpus)
    assert {"control:plain", "control:reader", "proof/connect"} <= set(every["classes"]["observed"])
    assert set(every["classes"]["observed"]) - set(without["classes"]["observed"]) == {
        "control:reader",
        "proof/connect",
    }
    assert "readers" not in every and without["readers"] is False
    assert lane_blocks.parse_queue(without).readers == lane_readers.NONE
    assert lane_blocks.parse_queue(every).readers == lane_readers.EVERY
    assert every["environment"]["PROOF_READERS"] == "all" and without["environment"]["PROOF_READERS"] == "0"
    keyed = {queued["group"]: queued["key"] for value in (every,) for b in value["blocks"] for queued in b["groups"]}
    apart = {queued["group"]: queued["key"] for b in without["blocks"] for queued in b["groups"]}
    assert set(apart) <= set(keyed) and all(keyed[group] != apart[group] for group in apart)
    early = _build(checkout, tmp_path / "early.json", "--lane-env", "PROOF_READERS=0", phase="early")
    assert early["readers"] is False
    # A slice of the readers queues what it observes: the package only Connect's tests fill where it names
    # Connect, and each control an entry of a reader it names holds.
    android = _build(checkout, tmp_path / "android.json", "--lane-env", "PROOF_READERS=android", corpus=corpus)
    assert android["readers"] == ["formplayer", "android"]
    assert android["environment"]["PROOF_READERS"] == "formplayer,android"
    assert "proof/connect" not in android["classes"]["observed"]
    assert {"control:plain", "control:reader"} <= set(android["classes"]["observed"])
    connect = _build(checkout, tmp_path / "connect.json", "--lane-env", "PROOF_READERS=connect", corpus=corpus)
    assert "proof/connect" in connect["classes"]["observed"]


def test_a_split_module_and_its_tests_are_queued_as_groups_of_their_own_keyed_by_their_packages_data(
    tmp_path, lane, monkeypatch
):
    """proof.checks.sharding.SPLIT: a module of a package's is a group of its own where it keeps a test it does not
    split off, each test it splits off one more, and the package's own group stays only while another module is
    left in it. Each is keyed apart, by its package's data (what its tests read)."""
    from proof.checks import sharding

    checkout, corpus = lane
    write_files(
        checkout,
        {
            "proof/editors/test_slow.py": (
                "def test_one():\n    pass\n\n\nclass TestTwo:\n    def test_two(self):\n        pass\n"
            ),
            "proof/core/test_whole.py": "def test_a():\n    pass\n\n\ndef test_b():\n    pass\n",
        },
    )
    monkeypatch.setattr(
        sharding, "SPLIT", {"editors/test_slow.py": ("test_one", "test_two"), "core/test_whole.py": ("test_a",)}
    )
    assert queue.package_groups(checkout / "proof") == [
        "proof/checks",
        "proof/core",
        "proof/core/test_whole.py",
        "proof/core/test_whole.py::test_a",
        "proof/editors",
        "proof/editors/test_slow.py::test_one",
        "proof/editors/test_slow.py::test_two",
        "surface",
    ]
    main = _build(checkout, tmp_path / "main.json", corpus=corpus)
    early = _build(checkout, tmp_path / "early.json", phase="early")

    def names(value):
        return {queued["group"]: queued.get("key") for block in value["blocks"] for queued in block["groups"]}

    assert {"proof/editors", "proof/editors/test_slow.py::test_one", "proof/editors/test_slow.py::test_two"} <= set(
        names(main)
    )
    assert {"proof/core", "proof/core/test_whole.py", "proof/core/test_whole.py::test_a"} <= set(names(early))
    keys = [*names(main).values(), *names(early).values()]
    assert len(set(keys)) == len(keys)


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


# Pieces ------------------------------------------------------------------------------------------


def _two_configurations(corpus, identifier):
    """Export the corpus document under a second configuration, as the emitter writes it, and name its inputs."""
    root = corpus / identifier
    for kind, files in (("export", ("create", "republish")), ("edit/export", ("update",))):
        for name in files:
            for suffix in ("body", "json"):
                source = root / kind / "minimum" / f"{name}.{suffix}"
                target = root / kind / "maximum" / f"{name}.{suffix}"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
    write_inputs(root)


def _queued(value):
    return {queued["group"]: queued for block in value["blocks"] for queued in block["groups"]}


def test_a_heavy_observed_document_is_queued_in_pieces_with_its_own_group_after_them(tmp_path, lane):
    checkout, corpus = lane
    _two_configurations(corpus, "two")
    # No threshold named, and none in the profile: every document is queued whole, as it always was.
    whole = _build(checkout, tmp_path / "whole.json", "--no-dedupe", corpus=corpus)
    assert "pieces" not in whole and "corpus:two@maximum" not in _queued(whole)
    assert _queued(whole)["corpus:two"] == {"group": "corpus:two", "fresh": False, "estimate": 6.0} | {
        "key": _queued(whole)["corpus:two"]["key"]
    }
    # Past 20 s on one worker: two is 6 box-seconds, 24 s on a worker of the four its profile's box holds; one is
    # 16 s, and is exported under one configuration besides.
    timings = json.loads((checkout / "proof" / "timings.json").read_text())
    timings["profiles"]["readers"]["execution"] = {"workers": 4, "split": 20}
    (checkout / "proof" / "timings.json").write_text(json.dumps(timings))
    split = _build(checkout, tmp_path / "split.json", "--no-dedupe", "--fresh", corpus=corpus)
    assert split["pieces"] == ["corpus:two@maximum", "corpus:two@minimum"]
    assert split["classes"]["observed"] == ["corpus:one", "corpus:two", "proof/checks", "proof/editors"]
    queued = _queued(split)
    share = round(6.0 * 0.65, 3)
    assert queued["corpus:two@maximum"] == {"group": "corpus:two@maximum", "fresh": True, "estimate": share}
    assert queued["corpus:two@minimum"] == {"group": "corpus:two@minimum", "fresh": True, "estimate": share}
    # Its own group follows them, is never fresh though the lane is, keeps the document's key, and costs judging.
    assert queued["corpus:two"] == {
        "group": "corpus:two",
        "fresh": False,
        "after": ["corpus:two@maximum", "corpus:two@minimum"],
        "estimate": round(6.0 * queue.JUDGED_SHARE, 3),
        "key": _queued(whole)["corpus:two"]["key"],
    }
    assert queued["corpus:one"]["fresh"] is True and "after" not in queued["corpus:one"]
    assert split["fresh"] == ["corpus:one", "corpus:two@maximum", "corpus:two@minimum", "proof/checks", "proof/editors"]
    # One block holds the three, though nothing is shared between documents (--no-dedupe), and the lane reads it.
    [block] = [block for block in split["blocks"] if any(g["group"] == "corpus:two" for g in block["groups"])]
    assert [g["group"] for g in block["groups"]] == ["corpus:two", "corpus:two@maximum", "corpus:two@minimum"]
    assert block["estimate"] == round(2 * share + 6.0 * queue.JUDGED_SHARE, 3)
    parsed = lane_blocks.parse_queue(split)
    assert parsed.block(block["id"]).groups[0].after == ("corpus:two@maximum", "corpus:two@minimum")
    # The threshold named by hand stands in the profile's place: none splits nothing, and nothing past it does.
    assert "pieces" not in _build(checkout, tmp_path / "none.json", "--split-above", "none", corpus=corpus)
    assert "pieces" not in _build(checkout, tmp_path / "high.json", "--split-above", "24", corpus=corpus)
    forced = _build(checkout, tmp_path / "forced.json", "--split-above", "0", corpus=corpus)
    assert forced["pieces"] == ["corpus:two@maximum", "corpus:two@minimum"]  # one has a single configuration
    out = tmp_path / "bad.json"
    assert (
        queue.main(["main", "--root", str(checkout), "--corpus", str(corpus), "--out", str(out), "--split-above", "x"])
        == 2
    )
    # The same inputs write the same bytes.
    again = _build(checkout, tmp_path / "again.json", "--no-dedupe", "--fresh", corpus=corpus)
    assert (tmp_path / "again.json").read_bytes() == (tmp_path / "split.json").read_bytes() and again == split


def test_a_document_the_store_holds_is_not_split_and_the_audit_sample_is(tmp_path, lane):
    checkout, corpus = lane
    _two_configurations(corpus, "two")
    cold = _build(checkout, tmp_path / "cold.json", "--split-above", "0", corpus=corpus)
    assert cold["pieces"] == ["corpus:two@maximum", "corpus:two@minimum"]
    _build(checkout, tmp_path / "whole.json", corpus=corpus)
    output = _ran(checkout, corpus, tmp_path / "out", tmp_path / "whole.json", failing={"corpus:two"})
    store = pack.write(pack.gather([output], [tmp_path / "whole.json"]), tmp_path / "store")
    # Its records are held, so it is judged from them, whole: no piece would have anything to observe.
    warm = _build(checkout, tmp_path / "warm.json", "--split-above", "0", corpus=corpus, stores=[store])
    assert warm["classes"]["judged"] == ["corpus:two"] and "pieces" not in warm
    # The audit sample observes it again, so there it is in pieces, fresh, its own group reading what they keep.
    seeds = {}
    for seed in ("1", "2", "3", "4", "5", "6"):
        arguments = ["--split-above", "0", "--audit-seed", seed, "--audit-units", "1"]
        seeds[seed] = _build(checkout, tmp_path / f"audit-{seed}.json", *arguments, corpus=corpus, stores=[store])
    sampled = next(value for value in seeds.values() if "corpus:two@maximum" in value["fresh"])
    assert sampled["fresh"] == ["corpus:two@maximum", "corpus:two@minimum"]
    assert _queued(sampled)["corpus:two"]["fresh"] is False
    assert _queued(sampled)["corpus:two"]["after"] == ["corpus:two@maximum", "corpus:two@minimum"]


def test_a_document_measured_in_pieces_is_split_by_its_whole_measure_and_each_group_costs_what_it_measured(
    tmp_path, lane
):
    checkout, corpus = lane
    _two_configurations(corpus, "two")
    groups = {"corpus:one": 4.0, "corpus:two": 0.5, "corpus:two@maximum": 3.5, "corpus:two@minimum": 2.5}
    profile = {"groups": groups, "execution": {"workers": 4, "split": 20}}
    (checkout / "proof" / "timings.json").write_text(json.dumps({"profiles": {"readers": profile}}))
    # Its own group measured 0.5 box-seconds, judging; with its pieces it is 6.5, 26 s on a worker, past 20.
    split = _queued(_build(checkout, tmp_path / "split.json", corpus=corpus))
    assert (split["corpus:two@maximum"]["estimate"], split["corpus:two@minimum"]["estimate"]) == (3.5, 2.5)
    assert split["corpus:two"]["estimate"] == 0.5
    # Under a threshold it does not pass, it is queued whole at its whole measure, never at its judging's.
    whole = _queued(_build(checkout, tmp_path / "whole.json", "--split-above", "30", corpus=corpus))
    assert whole["corpus:two"]["estimate"] == 6.5 and "corpus:two@maximum" not in whole
    # A document no run measured in pieces costs its profile's judged share of its whole to judge: with every
    # reader an observation is hours and its judging is not 15% of them, so that profile names its own.
    profile = {"groups": {"corpus:one": 4.0, "corpus:two": 6.0}, "execution": {"workers": 4, "split": 20}}
    (checkout / "proof" / "timings.json").write_text(json.dumps({"profiles": {"readers": profile}}))
    default = _queued(_build(checkout, tmp_path / "default.json", corpus=corpus))
    assert default["corpus:two"]["estimate"] == round(6.0 * queue.JUDGED_SHARE, 3)
    profile["execution"]["judged"] = 0.01
    (checkout / "proof" / "timings.json").write_text(json.dumps({"profiles": {"readers": profile}}))
    named = _queued(_build(checkout, tmp_path / "named.json", corpus=corpus))
    assert named["corpus:two"]["estimate"] == 0.06 and named["corpus:two@maximum"]["estimate"] == round(6.0 * 0.65, 3)
    profile["execution"]["judged"] = 0
    (checkout / "proof" / "timings.json").write_text(json.dumps({"profiles": {"readers": profile}}))
    arguments = ["main", "--root", str(checkout), "--corpus", str(corpus), "--out", str(tmp_path / "bad.json")]
    assert queue.main([*arguments, "--timings", str(checkout / "proof" / "timings.json")]) == 2


def test_a_run_over_documents_named_by_hand_queues_them_and_their_controls_and_names_what_it_leaves_out(tmp_path, lane):
    checkout, corpus = lane
    _two_configurations(corpus, "two")
    control = copied_control(checkout / "proof" / "controls")
    other = "elsewhere"
    shutil.copytree(control.root, checkout / "proof" / "controls" / other)
    entry = {"id": "d1", "defect": 1, "part": "p", "check": "bar", "artifact": "upload", "path": "/x"}
    register = [
        {**entry, "document": "two", "control": control.id},
        {**entry, "id": "d2", "document": "one", "control": other},
    ]
    (checkout / "proof" / "known-defects.json").write_text(json.dumps(register))
    whole = _build(checkout, tmp_path / "whole.json", corpus=corpus)
    assert "selection" not in whole and f"control:{other}" in _queued(whole)
    index = (corpus / "index.json").read_bytes()
    named = _build(checkout, tmp_path / "named.json", "--documents", "only:two", "--split-above", "0", corpus=corpus)
    # The document in pieces (its threshold forced), the control of the entry naming it, and nothing else.
    assert sorted(_queued(named)) == [
        f"control:{control.id}",
        *(f"control:{control.id}@{name}" for name in queue.configuration_names(control.root)),
        "corpus:two",
        "corpus:two@maximum",
        "corpus:two@minimum",
    ]
    assert named["selection"] == {"documents": ["two"], "left": [f"control:{other}", "proof/checks", "proof/editors"]}
    assert "unsampled" not in named and "sample" not in named
    parsed = lane_blocks.parse_queue(named)
    assert parsed.selection.documents == ("two",) and parsed.unsampled == ()
    # The corpus's index lists the named documents alone, so the lane collects only them; the rest stay on disk.
    listed = json.loads((corpus / "index.json").read_text())
    assert [entry["id"] for entry in listed["documents"]] == ["two"] and (corpus / "one" / "inputs.json").is_file()
    assert [entry["id"] for entry in listed["unsampled"]] == ["one"]
    # A document the corpus does not hold, a selection in the early queue and a seed with no sample are refused.
    (corpus / "index.json").write_bytes(index)
    out = str(tmp_path / "bad.json")
    base = ["--root", str(checkout), "--out", out]
    assert queue.main(["main", *base, "--corpus", str(corpus), "--documents", "only:two,gone"]) == 2
    assert queue.main(["main", *base, "--corpus", str(corpus), "--documents", "only:"]) == 2
    # A selection with no edited document would leave proof 5's check with nothing to run over, which the lane's
    # collection refuses: the builder says so before any shard starts.
    shutil.rmtree(corpus / "one" / "edit")
    assert queue.main(["main", *base, "--corpus", str(corpus), "--documents", "only:one"]) == 2
    assert queue.main(["main", *base, "--corpus", str(corpus), "--documents", "only:one,two"]) == 0
    (corpus / "index.json").write_bytes(index)
    assert queue.main(["early", *base, "--documents", "only:two"]) == 2
    assert (
        queue.main(["main", *base, "--corpus", str(corpus), "--documents", "only:two", "--sample-seed", "2026-W42"])
        == 2
    )
    assert (corpus / "index.json").read_bytes() == index
