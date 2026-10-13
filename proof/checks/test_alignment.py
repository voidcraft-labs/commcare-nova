"""Proof 2's alignment moves B's identities to A's and nothing else, so identity is judged once.

Contract: after ``alignment.aligned_app`` maps B's module and form ids and
``xmlns`` to A's by position, nothing of B's identities is left in what HQ
builds from it, and HQ's own ``set_form_versions`` finds each form of
``build(A)`` and keeps its version where the form is unchanged. The
plausible failures: a reference to a B id the mapping missed (proof 2 would
then report an identity change again), and a re-namespaced form HQ renders
differently (every form would get a new version, a difference proof 2
would blame on Nova).

The input is HQ's own suite-test app, published as Nova publishes (A), then
updated with every module id, form id and form ``xmlns`` replaced and
nothing else changed (B), the identity change a republish that mints new
identities makes. B's own build is the negative control, showing both
symptoms the alignment removes. The renamespacing itself is checked over
the forms Nova emits, from a corpus document.
"""

from __future__ import annotations

import json
import uuid

import pytest
from lxml import etree

from proof.checks import cases
from proof.checks.proof2 import parsed_build
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.operations import upload_field
from proof.hq.seams import build_seams
from proof.observe.alignment import align_positions, aligned_app, leftover_identities, renamespace_xform
from proof.observe.build import build_state

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})


def _with_new_identities(app_json):
    """The app as an update whose every module id, form id and form xmlns is new, and nothing else."""
    for module in app_json["modules"]:
        module["unique_id"] = uuid.uuid4().hex
        for form in module["forms"]:
            source = app_json["_attachments"].pop(f"{form['unique_id']}.xml")
            xmlns = f"http://openrosa.org/formdesigner/{uuid.uuid4()}"
            # The old xmlns is a URI written only where the form names its data namespace.
            source = source.replace(form["xmlns"], xmlns)
            form["xmlns"], form["unique_id"] = xmlns, uuid.uuid4().hex
            app_json["_attachments"][f"{form['unique_id']}.xml"] = source
    return app_json


def _data_versions(files):
    versions = {}
    for path, content in files.items():
        if path.startswith("modules-") and path.endswith(".xml"):
            root = etree.fromstring(content)
            data = next(el for el in root.iter() if etree.QName(el).localname == "instance")[0]
            versions[path] = data.get("version")
    return versions


def test_alignment_leaves_nothing_of_bs_identities_and_hq_keeps_unchanged_versions(hq, core_runner):
    with hq_check(CONFIGURATION) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        with build_seams(previous=None):
            a, hq_build = build_state(operations.held_app(state, app_id), record, "A")
        saved_a = hq_build.saved_build()
        a_doc = operations.held_app(state, app_id).to_json()
        update = nova_shaped_upload(_with_new_identities(hq_test_app()), "Suite app", app_id="captured")
        assert operations.apply_upload(state, operations.with_app_id(update, app_id)).status == 200
        b_app = operations.held_app(state, app_id)
        alignment = align_positions(a_doc, b_app.to_json())
        with build_seams(previous=saved_a):
            b, _ = build_state(b_app, record, "B")
        with build_seams(previous=saved_a):
            b_aligned, _ = build_state(aligned_app(operations.held_app(state, app_id), alignment), record, "B")
    assert a.complete and b.complete and b_aligned.complete
    forms = len(alignment.form_ids)
    assert len(alignment.value_map()) == len(alignment.module_ids) + 2 * forms and not alignment.unmatched

    # The negative control: B's own build carries B's identities, and HQ gave every form B's version.
    assert leftover_identities(parsed_build(b), alignment)
    assert set(_data_versions(b.files).values()) == {str(b.app_version)} != {str(a.app_version)}

    assert leftover_identities(parsed_build(b_aligned), alignment) == []
    assert _data_versions(b_aligned.files) == _data_versions(a.files)
    assert set(_data_versions(a.files).values()) == {str(a.app_version)}


def _first_document_with_forms():
    for document in cases.load_corpus().emitted:
        export = next(iter(document.exports.values()), None)
        if export is not None and _sources(export):
            return [pytest.param(document, id=document.id)]
    raise AssertionError("No corpus document has a form, so there is no Nova form to renamespace.")


def _sources(export):
    app = json.loads(upload_field(export.create.upload(), "app_file"))
    return {name: content for name, content in app.get("_attachments", {}).items() if name.endswith(".xml")}


@pytest.mark.parametrize("document", _first_document_with_forms())
def test_renamespacing_moves_only_the_data_namespace(document):
    for name, source in _sources(next(iter(document.exports.values()))).items():
        original = etree.fromstring(source.encode())
        data = next(el for el in original.iter() if etree.QName(el).localname == "instance")[0]
        old = etree.QName(data).namespace
        moved = renamespace_xform(source, "http://openrosa.org/formdesigner/proof-moved")
        moved_root = etree.fromstring(moved)
        namespaces = [etree.QName(el).namespace for el in original.iter() if isinstance(el.tag, str)]
        moved_namespaces = [etree.QName(el).namespace for el in moved_root.iter() if isinstance(el.tag, str)]
        assert moved_namespaces == [
            "http://openrosa.org/formdesigner/proof-moved" if namespace == old else namespace
            for namespace in namespaces
        ], name
        back = renamespace_xform(moved, old)
        assert etree.tostring(etree.fromstring(back), method="c14n2") == etree.tostring(original, method="c14n2"), name
        assert etree.tostring(etree.fromstring(back)) == etree.tostring(original), name


def test_renamespacing_keeps_the_sources_own_spelling_where_only_the_namespace_moves():
    """Contract: an aligned source is B's own bytes with the data namespace's name replaced, so what HQ reads of
    a stored source as text (its CommTrack test for the session's supply point is a substring test) reads the
    same before and after the alignment. Failure it catches: a source written again by a serializer, whose
    apostrophes are spelled another way, so HQ's build of the aligned app held a datum B's own build does not.
    The counterpart: where the namespace's name is also part of something else the source holds, the bytes
    with it replaced are another document, and the structural rewrite is what is returned."""
    old, new = "http://openrosa.org/formdesigner/b", "http://openrosa.org/formdesigner/a"
    source = (
        '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model>'
        f'<instance><data xmlns="{old}"><held/></data></instance>'
        '<bind nodeset="/data/held" calculate="instance(&apos;commcaresession&apos;)/session/data/supply_point_id"/>'
        "</model></h:head></h:html>"
    )
    moved = renamespace_xform(source, new).decode("utf-8")
    assert moved == source.replace(old, new)
    assert "instance(&apos;commcaresession&apos;)" in moved

    naming = source.replace("<held/>", f"<held>{old}</held>")
    rewritten = etree.fromstring(renamespace_xform(naming, new))
    held = next(element for element in rewritten.iter() if etree.QName(element).localname == "held")
    assert (etree.QName(held).namespace, held.text) == (new, old)
