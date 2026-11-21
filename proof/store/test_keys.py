"""Every key names exactly what can change its result: each input class changes the keys it should, and no other.

Contract (``proof.store.keys``, ``proof.store.fingerprints``): a stored
result is reused only under a key that covers every input that could change
it, and a key that covers more than that only costs hits. So each class of
input (a document's corpus files, by the part that reads them; a file of
the observation, browser or judge partitions; a register; the image, the
Postgres image, the architecture, the observation's environment) changes
exactly the keys of the results it can change: a document's key, its
judgments', each record part's storage key, a browser transcript's, and a
package group's (a package keyed on a sample of the corpus by that sample
alone); a test module changes the package groups' keys alone, but the one
whose items run in documents' groups (HQ's branch proof), which changes the
judgments' too; the reader bundle the corpus carries changes a corpus
document's judgment and the package groups that run it, and nothing a
control's judgment, an observation or a native family reads; and a file no
partition holds changes none. The parts that drive the browser name its
code in their own keys (proof 4's declared inputs), so the store keeps no
browser fingerprint beside any part. And a document's key
changes wherever any of its parts' keys does, since the queue builder
learns a document's parts from its key alone; a browser run's transcript
changes with any code that starts the browser or records what it did.

The plausible failures: a partition that leaves out a file its results read
(an edited judge reusing old judgments), a key that names a fingerprint it
need not (every record part observed again for an edit of the editor
driver, or of a test module), a document key that reads another document's files, a document
key that stays while a part's key moves (a driver edit leaving every
document cached, proof 4 never driven again), a transcript replayed over
outputs shaped by code that has since changed, a part whose key does not
read a file it observes, a reader change that observes a document whose
files did not change or leaves a stale judgment or a stale package verdict
cached, and a part key that names the image, which would
draw a unit's HQ entropy differently on each image and make two images'
records incomparable.

Each case is run through the production derivations (``proof.observe.unit``'s
part keys over the document's ``inputs.json`` with proof 4's declared
browser input, the queue builder's ``Builder`` and ``package_data``,
``keys``, ``fingerprints.compute``) over a checkout without git, read by
walking it, and a corpus written as the emitter lays it out.
"""

from __future__ import annotations

import dataclasses
import importlib
import json
import shutil
import subprocess

import pytest

from proof.checks.corpus import Document
from proof.observe import unit
from proof.store import fingerprints, keys, queue
from proof.store.conftest import CHECKOUT_FILES, document_of, smallest_control, write_files, write_inputs

PARTS = ("a", "b", "b_aligned", "b_edit")
KEYS = (
    "document one",
    "document two",
    "judgment one",
    *(f"{part} one" for part in PARTS),
    "local one",
    "a two",
    "transcript",
    "package",
    "corpus package",
    "sampled package",
)
# The case databases B and B-edit replay over, which a real document's D and D′ give (unit.case_databases).
DATABASES = {"b": "sha256:" + "d" * 64, "b_edit": "sha256:" + "e" * 64}


def _declared(checkout):
    """What proof 4's hook declares at B and B-edit (``proof.observe.proof4.inputs``), over ``checkout``'s driver."""
    browser = importlib.import_module("proof.observe.proof4").browser_fingerprint(checkout)
    return {state: {"proof4": {"browser": browser}} for state in ("B", "B-edit")}


def _stored(scope, document, checkout):
    """Each record part's storage key, its part key derived as the observation derives it."""
    inputs = unit.document_inputs(document)
    parts = unit.part_keys(inputs, "minimum", DATABASES, _declared(checkout))
    found = {part: keys.storage_key(scope, parts[part]) for part in PARTS}
    found["local"] = keys.storage_key(scope, unit.local_key(inputs))
    return found


def _all_keys(checkout, corpus, *, arch="arm64", image=None, environ=keys.LANE_ENVIRONMENT):
    found = fingerprints.compute(checkout, arch=arch, image=image)
    builder = queue.Builder([], found, {})
    builder.scope = keys.record_scope(found, environ)
    builder.document_scope = keys.document_scope(found, environ)
    one = builder.document("corpus:one", corpus / "one")
    two = builder.document("corpus:two", corpus / "two")
    stored_one = _stored(builder.scope, document_of(corpus, "one"), checkout)
    files = {identifier: keys.files_digest(corpus / identifier) for identifier in ("one", "two")}

    def package(name):
        data = queue.package_data(name, corpus, files, checkout)
        return keys.package_key(found, environ, name, data)

    return {
        "document one": one.key,
        "document two": two.key,
        "judgment one": keys.judgment_key(keys.group_key(one.key, found["judge"], {"minimum/a": "x"}), "bar"),
        **{f"{part} one": stored_one[part] for part in (*PARTS, "local")},
        "a two": _stored(builder.scope, document_of(corpus, "two"), checkout)["a"],
        "transcript": keys.transcript_key(builder.document_scope, "spec", "first"),
        "package": keys.package_key(found, environ, "proof/core", {}),
        "corpus package": package("proof/checks"),
        "sampled package": package("proof/editors"),
    }


def _changed(before, after):
    return {name for name in KEYS if before[name] != after[name]}


def _edit(path, text):
    path.write_text(path.read_text() + text)


def _corpus_edit(relative):
    def edit(checkout, corpus):
        _edit(corpus / relative, " edited")
        write_inputs(corpus / relative.split("/", 1)[0])

    return edit


EVERY_RECORD = {"document one", "document two", "judgment one", *(f"{p} one" for p in (*PARTS, "local")), "a two"}
PACKAGES = {"package", "corpus package", "sampled package"}
# What the observation's code, the lane's container files and the platform reach: every record, every browser run.
OBSERVED = EVERY_RECORD | {"transcript"}
CASES = {
    "a create body": (
        _corpus_edit("one/export/minimum/create.body"),
        {"document one", "judgment one", *(f"{part} one" for part in PARTS), "corpus package"},
    ),
    "a republish body": (
        _corpus_edit("one/export/minimum/republish.body"),
        {"document one", "judgment one", "b one", "b_aligned one", "corpus package"},
    ),
    "an edit's update body": (
        _corpus_edit("one/edit/export/minimum/update.body"),
        {"document one", "judgment one", "b_edit one", "corpus package"},
    ),
    "a local archive": (
        _corpus_edit("one/local.ccz"),
        {"document one", "judgment one", "b_aligned one", "local one", "corpus package"},
    ),
    "the corpus's index": (
        lambda checkout, corpus: write_files(
            corpus, {"index.json": (corpus / "index.json").read_text().replace('"sample": 0', '"sample": 2')}
        ),
        {"corpus package", "sampled package"},
    ),
    "the sampled document": (
        _corpus_edit("two/export/minimum/create.body"),
        {"document two", "a two", "corpus package", "sampled package"},
    ),
    "an observation file": (
        lambda checkout, corpus: _edit(checkout / "proof/observe/unit.py", "# edited\n"),
        OBSERVED | PACKAGES,
    ),
    "a comparator the observation runs": (
        lambda checkout, corpus: _edit(checkout / "proof/checks/compare/trace.py", "# edited\n"),
        OBSERVED | PACKAGES,
    ),
    "what records and shapes a browser run": (
        lambda checkout, corpus: _edit(checkout / "proof/editors/pages.py", "# edited\n"),
        OBSERVED | PACKAGES,
    ),
    "a browser file": (
        lambda checkout, corpus: _edit(checkout / "proof/editors/driver/driver.mjs", "// edited\n"),
        {"document one", "document two", "judgment one", "b one", "b_aligned one", "b_edit one", "transcript"}
        | PACKAGES,
    ),
    "a test module of a package the observation runs": (
        lambda checkout, corpus: _edit(checkout / "proof/core/test_core.py", "# edited\n"),
        PACKAGES,
    ),
    "the branch proof, whose items run in documents' groups": (
        lambda checkout, corpus: write_files(
            checkout, {"proof/hq/test_branches.py": "def test_branches():\n    pass\n"}
        ),
        {"judgment one"} | PACKAGES,
    ),
    "the lane's container files": (
        lambda checkout, corpus: _edit(checkout / "proof/run.mjs", "// edited\n"),
        OBSERVED | PACKAGES,
    ),
    "a judge file": (
        lambda checkout, corpus: _edit(checkout / "proof/checks/bar.py", "# edited\n"),
        {"judgment one"} | PACKAGES,
    ),
    "the known-defect register": (
        lambda checkout, corpus: (checkout / "proof/known-defects.json").write_text('[{"id": "x"}]\n'),
        {"judgment one"} | PACKAGES,
    ),
    "the fixed-defect register": (
        lambda checkout, corpus: (checkout / "proof/fixed-defects.json").write_text('[{"id": "x"}]\n'),
        {"judgment one"} | PACKAGES,
    ),
    "the changes register": (
        lambda checkout, corpus: (checkout / "proof/first-publish-changes.json").write_text('[{"change": "x"}]\n'),
        {"judgment one"} | PACKAGES,
    ),
    "the surface manifest": (
        lambda checkout, corpus: (checkout / "lib/commcare/surface/surface.json").write_text('{"items": []}\n'),
        {"judgment one"} | PACKAGES,
    ),
    "the Postgres image": (
        lambda checkout, corpus: write_files(
            checkout,
            {"proof/compose.yaml": CHECKOUT_FILES["proof/compose.yaml"].replace("b" * 64, "d" * 64)},
        ),
        OBSERVED | PACKAGES,
    ),
    "a file no partition holds": (
        lambda checkout, corpus: _edit(checkout / "app/page.tsx", "// edited\n"),
        set(),
    ),
}


@pytest.mark.parametrize("case", sorted(CASES))
def test_each_input_changes_exactly_the_keys_of_what_it_can_change(checkout, corpus, case):
    before = _all_keys(checkout, corpus)
    edit, expected = CASES[case]
    edit(checkout, corpus)
    changed = _changed(before, _all_keys(checkout, corpus))
    assert changed == expected
    # The queue builder reads a document's parts under its key alone: whatever moves a part's key moves it.
    assert not changed & {f"{part} one" for part in (*PARTS, "local")} or "document one" in changed
    assert "a two" not in changed or "document two" in changed


def test_the_image_architecture_and_environment_change_what_runs_on_them(checkout, corpus):
    before = _all_keys(checkout, corpus)
    assert _changed(before, _all_keys(checkout, corpus, image="sha256:" + "e" * 64)) == set(KEYS)
    assert _changed(before, _all_keys(checkout, corpus, arch="amd64")) == set(KEYS)
    # HQ's speed seams off change what HQ records, what a package's tests run under, and what a browser run is
    # started in.
    unseamed = {**keys.LANE_ENVIRONMENT, "PROOF_HQ_SPEED": "0"}
    assert _changed(before, _all_keys(checkout, corpus, environ=unseamed)) == set(KEYS)
    # A run without the readers (proof.lane.readers) records no served state and runs no test that starts one:
    # every record, judgment, transcript and package outcome is keyed apart from a run with them, so neither
    # profile reads the other's; and naming the readers' default changes nothing.
    without = {**keys.LANE_ENVIRONMENT, "PROOF_READERS": "0"}
    assert _changed(before, _all_keys(checkout, corpus, environ=without)) == set(KEYS)
    with_readers = {**keys.LANE_ENVIRONMENT, "PROOF_READERS": "all"}
    assert _changed(before, _all_keys(checkout, corpus, environ=with_readers)) == set()
    # A slice of the readers is a set of its own, apart from every reader and from none.
    android = _all_keys(checkout, corpus, environ={**keys.LANE_ENVIRONMENT, "PROOF_READERS": "android"})
    assert _changed(before, android) == set(KEYS)
    assert _changed(_all_keys(checkout, corpus, environ=without), android) == set(KEYS)
    # The audit switches only check: the lane's shards run with the editor audit on and still read the store. The
    # image sets where its checkouts are, which its digest names: the queue builder, outside it, keys alike.
    audited = {**keys.LANE_ENVIRONMENT, "PROOF_EDITOR_AUDIT": "0.03", "PROOF_VERIFY_MEMOS": "1"}
    audited |= {"PROOF_HQ": "/opt/hq", "PROOF_CORE": "/opt/core", "PROOF_HQ_SCHEMA": "/opt/hq-schema/hq.sql"}
    assert _changed(before, _all_keys(checkout, corpus, environ=audited)) == set()


def test_a_part_key_names_its_inputs_and_no_fingerprint_so_every_image_draws_the_same_entropy_under_it():
    inputs = {"inputs": {"create.request.body": "sha256:" + "1" * 64}}
    a = keys.part_key("a", None, inputs)
    assert a == keys.part_key("a", None, dict(inputs)) and len(a) == keys.KEY_BYTES
    assert keys.part_key("b", a, inputs) != keys.part_key("b", None, inputs)
    assert keys.part_key("a", None, {"inputs": {"create.request.body": "sha256:" + "2" * 64}}) != a
    scope = {"observation": "o", "image": "i", "postgres": "p", "arch": "arm64", "environment": {}}
    other = {**scope, "image": "j"}
    assert keys.storage_key(scope, a) != keys.storage_key(other, a)
    # The kinds proof.observe.unit keys, and a parent that is another part's key: anything else is refused.
    with pytest.raises(keys.KeyInputError, match="none of them"):
        keys.part_key("b_edit", a, inputs)
    with pytest.raises(keys.KeyInputError, match="parent"):
        keys.part_key("b", a.hex(), inputs)


def test_only_the_served_edits_declared_platforms_change_its_part_key(tmp_path, monkeypatch):
    from proof.observe import proof4

    root = tmp_path / "subject"
    write_files(root, {"document.json": '{"doc":{}}', "edit/batch.json": "[]"})
    parts = {"configurations": {"minimum": {part: {} for part in ("a", "b", "b_edit")}}, "local": {}}

    def keys_for(settings, name):
        write_files(root, {"edit/document.json": json.dumps({"doc": {"name": name, "appSettings": settings}})})
        document = Document(id=root.name, source="fixture", root=root)
        held = {state: {"proof4": proof4.inputs(document, state)} for state in ("B", "B-edit")}
        return held["B-edit"]["proof4"], unit.part_keys(parts, "minimum", DATABASES, held)

    monkeypatch.setenv("PROOF_READERS", "all")
    both, original = keys_for({}, "First")
    edited, changed = keys_for({"runsOnlyOn": "android"}, "First")
    assert both["platforms"] == ["android", "web-apps"] and edited["platforms"] == ["android"]
    assert {part for part in original if original[part] != changed[part]} == {"b_edit"}
    assert keys_for({"runsOnlyOn": "android"}, "Another name")[1] == changed
    monkeypatch.setenv("PROOF_READERS", "0")
    unserved, before = keys_for({}, "First")
    assert "platforms" not in unserved and keys_for({"runsOnlyOn": "android"}, "First")[1] == before


def test_an_editor_release_serves_the_keyed_cases_and_platforms_without_reopening_the_edit(tmp_path, monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace

    from proof.formplayer import hq
    from proof.observe import proof4, served, sessions
    from proof.observe.record import Blobs

    root = tmp_path / "subject"
    write_files(
        root,
        {
            "document.json": '{"doc":{},"catalog":[]}',
            "edit/batch.json": "[]",
            "edit/document.json": json.dumps(
                {
                    "doc": {"appSettings": {"runsOnlyOn": "android"}, "userProperties": {"id": {"slug": "team"}}},
                    "catalog": [],
                }
            ),
        },
    )
    monkeypatch.setenv("PROOF_READERS", "all")
    monkeypatch.setattr(unit, "HOOKS", unit.hooks())
    document = Document(root.name, "producer:fixture", root)
    cases, _ = unit._case_inputs(document)
    declared = {"B-edit": {"proof4": proof4.inputs(document, "B-edit")}}
    assert dict(cases["b_edit"].user_data)["team"] == "proof team"
    # The guard withholds this file outside key derivation. Use a fresh document so a previous read cannot
    # make an accidental dependency pass, and withhold the source before constructing proof 4's context.
    (root / "edit/document.json").unlink()
    cold = Document(document.id, document.source, root)
    export = SimpleNamespace(configuration=SimpleNamespace(name="minimum"), content=SimpleNamespace(lookups=None))
    observation = unit._Unit(cold, export, None, None, None, None, None, Blobs(), {}, cases, declared)
    monkeypatch.setattr(sessions, "hq_restore", lambda *_: ({"served": True}, b"restore"))
    built = SimpleNamespace(outcome=None, hq_build=None, archive=None)
    context = observation.b_context(None, "B-edit", built, None)
    assert context.serve
    # The native HQ endpoint consumes only these two resolved inputs. D or D′ here would let it read the
    # unkeyed source a second time after the real release was built.
    monkeypatch.setattr(served, "_runner", lambda: None)
    monkeypatch.setattr(hq, "serve", lambda _unit, raw, app_id, **inputs: nullcontext((raw, inputs)))
    with proof4._Observation(context, None)._serving("proof4-save", None) as connection:
        raw, inputs = connection.served
        assert raw is None and inputs["database"] is cases["b_edit"] and inputs["platforms"] == {"android"}


def test_each_part_that_drives_a_browser_names_the_browsers_code_in_its_key(tmp_path, corpus):
    # A browser reaches an observation only through the contexts the unit gives its hooks: the served hook's at A
    # (the Web Apps client's screens) and proof 4's at B and B-edit (HQ's editors, and the client after a save).
    assert "editor_driver" in {field.name for field in dataclasses.fields(unit.HookContext)}
    assert "editor_driver" in {field.name for field in dataclasses.fields(unit.BContext)}
    driving = {name: states for name, function, states in unit.EVERY_HOOK if name in ("served", "proof4")}
    assert driving == {"served": ("A",), "proof4": ("B", "B-edit")}
    browser = importlib.import_module("proof.observe.browser")
    # Each declares the driver's code among what it reads, which joins those parts' keys.
    document = smallest_control()
    for name, states in driving.items():
        hook = importlib.import_module(f"proof.observe.{name}")
        for state in states:
            assert browser.browser_fingerprint() in json.dumps(hook.inputs(document, state))
    root = tmp_path / "checkout"
    shutil.copytree(fingerprints.WORKTREE / "proof/editors/driver", root / "proof/editors/driver")
    before = browser.browser_fingerprint(root)
    _edit(root / "proof/editors/driver/driver.mjs", "// edited\n")
    assert browser.browser_fingerprint(root) != before
    inputs = unit.document_inputs(document_of(corpus, "one"))
    declared = {"A": {"served": {"browser": before}}, **{s: {"proof4": {"browser": before}} for s in ("B", "B-edit")}}
    held = unit.part_keys(inputs, "minimum", DATABASES, declared)
    # A is every part's parent, so the browser's code at A names them all; at B, B and what is observed over it.
    for state, hook, changed in (
        ("A", "served", {"a", "b", "b_aligned", "b_edit"}),
        ("B", "proof4", {"b", "b_aligned"}),
        ("B-edit", "proof4", {"b_edit"}),
    ):
        edited = unit.part_keys(inputs, "minimum", DATABASES, {**declared, state: {hook: {"browser": "edited"}}})
        assert {part for part in held if held[part] != edited[part]} == changed


def test_a_changed_reader_bundle_judges_every_corpus_document_again_and_observes_none(
    tmp_path, checkout, corpus, monkeypatch
):
    """The reader bundle the corpus carries (``native/reader/``) is in a corpus document's judged key
    (``keys.judged_under``) and in the key of each package whose tests run it (``queue.PACKAGE_DATA``'s
    ``reader``), and in no other: no part, document or transcript key, no control's judgment, no native family's
    digest. So over a store holding a whole run, a bundle that differs by one byte, beside the same documents,
    queues every corpus document as judged, observes none, keeps every control cached, runs again the package
    groups that run the bundle (``proof/matrix``'s two and ``proof/checks``), and keeps every other one cached,
    the one that reads the native products among them. Run again and packed, every group is cached under the new
    bundle."""
    from proof.checks import sharding
    from proof.store import pack
    from proof.store.conftest import copied_control
    from proof.store.test_queue import _build, _queued, _ran

    monkeypatch.setattr(sharding, "SPLIT", {})
    monkeypatch.setattr(sharding, "SPLIT_BY_PARAMETER", {"matrix/test_retained.py": "matrix/bases.json"})
    groups = {"corpus:one": 4.0, "corpus:two": 6.0, "proof/checks": 9.0}
    timings = {"profiles": {"readers": {"groups": groups}, "no-readers": {"groups": groups}}}
    write_files(
        checkout,
        {
            "proof/timings.json": json.dumps(timings),
            "proof/matrix/conftest.py": 'DOCUMENTS = ("one",)\n',
            "proof/matrix/bases.json": '["one"]',
            "proof/matrix/test_retained.py": "def test_retained():\n    pass\n",
            "proof/matrix/test_seed.py": "def test_seed():\n    pass\n",
            "proof/native/test_family.py": "def test_family():\n    pass\n",
        },
    )
    control = copied_control(checkout / "proof" / "controls")
    register = [{"id": "d1", "check": "bar", "document": "one", "control": control.id}]
    (checkout / "proof" / "known-defects.json").write_text(json.dumps(register))
    documents = ["corpus:one", "corpus:two"]
    running = ["proof/checks", "proof/matrix", "proof/matrix/test_retained.py[one]"]
    others = ["proof/editors", "proof/native"]
    every = sorted([control.group, *documents, *running, *others])

    cold = _build(checkout, tmp_path / "cold.json", corpus=corpus)
    assert cold["reader"] == keys.reader_digest(corpus) is not None
    assert cold["classes"]["observed"] == every
    store = pack.write(
        pack.gather([_ran(checkout, corpus, tmp_path / "cold-run", tmp_path / "cold.json")], [tmp_path / "cold.json"]),
        tmp_path / "cold-store",
    )
    warm = _build(checkout, tmp_path / "warm.json", corpus=corpus, stores=[store])
    assert warm["classes"] == {"cached": every, "judged": [], "observed": []}

    bundle = corpus / keys.READER / "reader.mjs"
    changed_bytes = bytearray(bundle.read_bytes())
    changed_bytes[0] ^= 1
    bundle.write_bytes(bytes(changed_bytes))
    native = keys.native_digest(corpus)
    changed = _build(checkout, tmp_path / "changed.json", corpus=corpus, stores=[store])
    assert changed["reader"] == keys.reader_digest(corpus) != cold["reader"]
    assert keys.native_digest(corpus) == native
    assert changed["classes"] == {
        "cached": sorted([control.group, *others]),
        "judged": documents,
        "observed": running,
    }
    # The documents' own keys, which name their record parts, did not move: only their judged keys did.
    assert [_queued(changed)[name]["key"] for name in documents] == [_queued(cold)[name]["key"] for name in documents]

    # Judged again under the new bundle, the run's judgments are kept under it, and the next queue reads them.
    again = _ran(checkout, corpus, tmp_path / "changed-run", tmp_path / "changed.json")
    store = pack.write(pack.merged([store, pack.gather([again], [tmp_path / "changed.json"])]), tmp_path / "store")
    after = _build(checkout, tmp_path / "after.json", corpus=corpus, stores=[store])
    assert after["classes"] == {"cached": every, "judged": [], "observed": []}


def test_a_git_checkout_is_fingerprinted_from_its_index_and_its_edits_as_a_walked_copy_is(tmp_path, checkout):
    if shutil.which("git") is None:
        pytest.fail("git is not on PATH, and the fingerprints of a checkout are read through it.")
    repository = tmp_path / "repository"
    shutil.copytree(checkout, repository)

    def git(*arguments):
        subprocess.run(["git", "-C", str(repository), *arguments], check=True, capture_output=True)

    git("init", "-q")
    git("add", "-A")
    git("-c", "user.name=proof", "-c", "user.email=proof@example.com", "commit", "-q", "-m", "checkout")
    assert (repository / ".git").is_dir()
    assert fingerprints.git_files(repository) == fingerprints.walked_files(checkout)
    # An edit not yet staged and a new file git does not ignore are fingerprinted as they are on disk.
    _edit(repository / "proof/checks/bar.py", "# edited\n")
    (repository / "proof/checks/new.py").write_text("NEW = 1\n")
    _edit(checkout / "proof/checks/bar.py", "# edited\n")
    (checkout / "proof/checks/new.py").write_text("NEW = 1\n")
    assert fingerprints.git_files(repository) == fingerprints.walked_files(checkout)
    assert fingerprints.compute(repository, arch="arm64") == fingerprints.compute(checkout, arch="arm64")
