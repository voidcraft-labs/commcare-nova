"""Two disjoint editor observations must keep the complete byte-level record of an ordinary B."""

import copy
import json
import os
import shutil
from dataclasses import replace
from types import SimpleNamespace

import pytest

from proof.observe import editor_slices
from proof.observe.record import Blobs, canonical


def _fragments():
    parent = bytes(range(32))
    views = [("view_form", "f1", [0, 0])]
    forms = [(0, 0, "f1"), (0, 1, "f2")]
    parts = []

    def observed(log, item, evidence):
        log.log.append({"label": evidence, "softAssertions": [{"value": evidence}]})
        log.requests.append({"request": evidence, "softAssertions": [{"message": "observed"}]})
        if "view" in item:
            return {
                **item,
                "result": evidence,
                "offers": [{"section": "form settings", "offer": "offered"}],
                "sections": [{"section": "form settings", "report": "real section output"}],
            }
        return {**item, "result": evidence, "offer": "offered", "runs": [{"report": "first"}, {"report": "again"}]}

    for worker in (1, 2):
        capture = editor_slices.Capture(parent, worker, 2)
        capture.plan(views, forms)
        log = SimpleNamespace(log=[{"label": "publish"}], requests=[{"request": "start"}])

        for kind in ("views", "vellum"):
            for i, item in enumerate(capture.inventory[kind]):
                if capture.owns(kind, i):
                    capture.run(kind, i, log, observed, log, item, f"{kind}/{i}")
        # The disk store reads canonical JSON, so alphabetically serialized keys put vellum before views.
        record = {"operations": log.log, "requests": log.requests, "proof4": {"baseline": "observed"}}
        parts.append(json.loads(canonical(capture.fragment(record, Blobs())[0])))
    return parent, parts


def test_native_editor_order_reassembles_both_kinds_of_receipt_including_repetitions():
    parent, parts = _fragments()
    extra = copy.deepcopy(parts[0]["entries"]["views"][0]["requests"][0])
    parts[0]["entries"]["views"][0]["requests"].append(extra)
    record = editor_slices.merge(parent, parts)
    assert [op["label"] for op in record["operations"]] == ["publish", "views/0", "vellum/0", "vellum/1"]
    assert [op["softAssertions"][0]["value"] for op in record["operations"][1:]] == ["views/0", "vellum/0", "vellum/1"]
    assert [note["request"] for note in record["requests"]] == ["start", "vellum/0", "vellum/1", "views/0", "views/0"]
    assert [row["result"] for row in record["proof4"]["vellum"]] == ["vellum/0", "vellum/1"]


@pytest.mark.parametrize(
    "change", ["absent", "repeated", "target", "parent", "baseline", "request", "memo", "section", "again"]
)
def test_incomplete_or_disagreeing_editor_workers_are_refused(change):
    parent, parts = _fragments()
    if change == "absent":
        parts.pop()
    elif change == "repeated":
        parts[0]["entries"]["views"] *= 2
    elif change == "target":
        parts[1]["entries"]["vellum"][0]["record"]["target"] = "f1"
    elif change == "parent":
        parts[0]["parent"] = "another"
    elif change == "baseline":
        parts[1]["common"]["proof4"]["baseline"] = "another"
    elif change == "request":
        parts[1]["common"]["requests"].append({"request": "an extra request with a soft assertion"})
    elif change == "section":
        parts[0]["entries"]["views"][0]["record"]["sections"].clear()
    elif change == "again":
        parts[1]["entries"]["vellum"][0]["record"]["runs"].pop()
    elif change == "memo":
        for part in parts:
            part["servedKeys"] = ["same-native-state-on-both-workers"]
    with pytest.raises(ValueError):
        editor_slices.merge(parent, parts)


def _original_only(source, root):
    """The emitted HQ app with its optional later Nova edit left out, and the emission's exact role digests."""
    from proof.observe import unit

    shutil.copytree(source.root, root, ignore=shutil.ignore_patterns("edit"))
    doc = replace(source, root=root)
    inputs = doc.inputs
    paths = unit.input_files(doc)
    for configuration, parts in paths["configurations"].items():
        original = inputs["configurations"][configuration]
        inputs["configurations"][configuration] = {
            part: {role: original[part][role] for role in roles} for part, roles in parts.items()
        }
    inputs["local"] = {role: inputs["local"][role] for role in paths["local"]}
    inputs["judge"].pop("batch")
    (root / "inputs.json").write_bytes(canonical(inputs))
    assert unit.document_inputs(doc) == unit.computed_inputs(doc)
    return doc


@pytest.mark.reader("formplayer", "webapps", "android", "connect")
@pytest.mark.under_determinism
def test_the_two_editor_workers_produce_the_same_native_parts_receipts_and_blobs_as_the_whole_unit(
    hq, core_runner, editor_driver, tmp_path
):
    from proof.checks import cases
    from proof.observe import unit
    from proof.store import disk, guard, runtime

    document = _original_only(cases.load_corpus().document("hq-plain"), tmp_path / "corpus" / "hq-plain")
    guard.install()

    # Each Store instance is opened anew. The unit and each worker have independent sessions and fork B
    # from HQ's actual persisted state. Their only handoff to the judge is through canonical bytes on disk.
    def open_store(where):
        fingerprint = {
            "observation": "test",
            "browser": "browser",
            "image": "image",
            "postgres": "postgres",
            "arch": "ci",
        }
        return runtime.Store(
            runtime.snapshot(None),
            disk.Delta(where / "store"),
            fingerprint,
            os.environ,
            fresh=False,
            audit_directory=where / "audit",
        )

    native = {"core_runner": core_runner, "editor_driver": editor_driver}
    reference_store = open_store(tmp_path / "reference")
    original = unit.observe_document(document, store=reference_store, **native)
    split = tmp_path / "split"
    # The second piece can finish before the first, without a full A or any of the first worker's part bytes.
    unit.observe_partition(document, "minimum", 2, 2, store=open_store(split), **native)
    with pytest.raises(unit.PartsNotHeld):
        unit.join_partitions(document, "minimum", 2, store=open_store(split))
    unit.observe_partition(document, "minimum", 1, 2, store=open_store(split), **native)
    unit.join_partitions(document, "minimum", 2, store=open_store(split))
    merged_store = open_store(split)
    merged = unit.observe_document(document, store=merged_store, held_only=True, **native)
    assert merged.observed == [] and merged.digests() == original.digests()
    keys = original.configurations["minimum"].keys
    for key in [*keys.values(), original.local_key]:
        assert merged_store.lookup(key) == reference_store.lookup(key)
        assert merged_store.blobs(key).refs() == reference_store.blobs(key).refs()
        for name in reference_store.blobs(key).refs():
            assert merged_store.blobs(key).get(name) == reference_store.blobs(key).get(name)
    b = merged.configurations["minimum"].b
    assert b["operations"] and b["operations"] == original.configurations["minimum"].b["operations"]
    assert b["proof4"]["served"]["webapps"] and b["proof4"]["served"]["androidTablet"]
    forms = b["proof4"]["vellum"]
    assert len(forms) == 2 and b["proof4"]["views"]
    # A real archive changed on each side: each form's first save reached Formplayer and a device.
    for form in forms:
        assert len(form["runs"]) == 2
        saved = form["runs"][0]["served"]
        assert saved["formplayer"]["trace"] and saved["android"]
