"""Compare the worker lexer profiles with HQ's actual XForm XML boundary."""

import base64
import json
from pathlib import Path
import re
import xml.parsers.expat
from xml.etree import ElementTree

from lxml import etree

from proof.connect import hq as connect_hq
from proof.editors import compare
from proof.editors.conftest import ADVANCED_APP, publish_hq_app, write_evidence
from proof.editors.test_advanced_index_identifier import (
    LOOKUP_FORM,
    OTHER_WORKER_CASE,
    PARENT,
    _authenticated_restore,
    _worker_case,
    _worker_database,
)
from proof.formplayer import hq as formplayer_hq
from proof.hq import operations
from proof.hq import redis as hq_redis
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.test_publish import _ask

ROOT = Path(__file__).resolve().parents[2]
CASE = "http://commcarehq.org/case/transaction/v2"

# XML 1.0 (fifth edition) NCName grammar over the two pinned UTF-16 lexers' BMP units.
XML_START = "A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD"
NCNAME = re.compile(f"[{XML_START}][{XML_START}.0-9\u00B7\u0300-\u036F\u203F-\u2040-]*")
CONTROLS = {
    "ascii-hyphen": "my-parent",
    "latin-1": "Équipe",
    "shared-greek": "Ωprobe",
    "shared-digraph": "Ĳprobe",
    "shared-nko-digit": "probe߀",
    "web-only-georgian": "აprobe",
    "combining-mark": "probe-e\u0301",
    "invalid-xml-mu": "µprobe",
    "namespace-colon": "my:parent",
    "invalid-xml-control": "bad\u0003name",
}


def _units(pairs):
    return {unit for first, last in zip(pairs[::2], pairs[1::2], strict=True)
            for unit in range(first, last + 1)}


def _profiles():
    return [
        {kind: _units(pairs) for kind, pairs in json.loads((ROOT / path).read_text()).items()}
        for path in ("lib/domain/portableNameRanges.json", "lib/domain/androidNameRanges.json")
    ]


def _portable_names():
    profiles = _profiles()
    initial = profiles[0]["initial"] & profiles[1]["initial"]
    continuation = (profiles[0]["initial"] | profiles[0]["continuationOnly"]) & (
        profiles[1]["initial"] | profiles[1]["continuationOnly"]
    )
    return {
        "initial": {unit: f"{chr(unit)}probe" for unit in sorted(initial)},
        "continuation": {unit: f"probe{chr(unit)}" for unit in sorted(continuation)},
    }


def test_advanced_index_alphabet_has_distinct_hq_xml_boundaries(hq):
    from corehq.apps.app_manager.xform import make_case_elem
    from corehq.util.xml_utils import safe_fromstring

    def construct(name):
        try:
            return etree.QName(make_case_elem(name)).localname == name
        except ValueError:
            return False

    def parse(name):
        wire = f'<{name} xmlns="{CASE}"/>'.encode()
        try:
            return etree.QName(safe_fromstring(wire)).localname == name
        except (ValueError, etree.XMLSyntaxError):
            return False

    def parse_expat(name):
        wire = f'<{name} xmlns="{CASE}"/>'.encode()
        try:
            return ElementTree.fromstring(wire).tag == f"{{{CASE}}}{name}"
        except ElementTree.ParseError:
            return False

    authorities = {
        "hq-namespaced-constructor": construct,
        "hq-raw-xml-parser": parse,
        "expat-parser": parse_expat,
    }
    alphabet = {
        position: {
            "shared-lexer-units-outside-xml-ncname": [
                unit for unit, name in names.items() if NCNAME.fullmatch(name) is None
            ],
            **{
                source: [unit for unit, name in names.items() if NCNAME.fullmatch(name) and accepts(name)]
                for source, accepts in authorities.items()
            },
        }
        for position, names in _portable_names().items()
    }
    controls = {
        label: {
            "name": name,
            "xml-ncname": NCNAME.fullmatch(name) is not None,
            **{source: accepts(name) for source, accepts in authorities.items()},
        }
        for label, name in CONTROLS.items()
    }

    with hq_check(Configuration(privileges={"CHILD_CASES"})) as (state, record):
        app_id = publish_hq_app(state, ADVANCED_APP)
        for label in ("ascii-hyphen", "latin-1", "shared-greek", "shared-digraph", "shared-nko-digit", "web-only-georgian"):
            with state.fork():
                app = operations.held_app(state, app_id)
                form = app.modules[1].forms[1]
                form.actions.open_cases[0].case_indices[0].reference_id = CONTROLS[label]
                app.save()
                try:
                    built = compare.build(state, app_id, record)
                except ValueError as error:
                    controls[label]["hq-build"] = str(error)
                else:
                    controls[label]["hq-build"] = (
                        "errors" if built.errors else etree.fromstring(built.files["modules-1/forms-1.xml"])
                        .xpath("//*[local-name()='index']/*[local-name()=$name]", name=CONTROLS[label]) != []
                    )

    versions = {"libxml": etree.LIBXML_VERSION, "lxml": etree.LXML_VERSION, "expat": xml.parsers.expat.EXPAT_VERSION}
    write_evidence("advanced-index-xml-transport", {"versions": versions, "alphabet": alphabet, "controls": controls})
    print(json.dumps({
        "versions": versions,
        "alphabet": {position: {source: len(units) for source, units in sources.items()}
                     for position, sources in alphabet.items()},
        "controls": controls,
    }, ensure_ascii=True))
    assert controls["latin-1"]["hq-build"] is True
    assert controls["shared-greek"]["hq-build"] is True
    assert controls["namespace-colon"]["hq-namespaced-constructor"] is False
    assert controls["invalid-xml-control"]["hq-raw-xml-parser"] is False


OTHER_PARENT = "other-clinic"
COMBINING_INDEX = "probe-e\u0301"
GROUP_SIZE = 125
JR = "http://openrosa.org/jr/xforms"


def _sweep_rows():
    portable = _portable_names()
    initial = {unit for unit, name in portable["initial"].items() if NCNAME.fullmatch(name)}
    continuation = {unit for unit, name in portable["continuation"].items() if NCNAME.fullmatch(name)}
    # One name exercises an initial character in both positions. Each remaining
    # continuation unit appears inside one ordinary name.
    named = [
        *(f"{chr(unit)}probe{chr(unit)}" for unit in sorted(initial)),
        *(f"probe{chr(unit)}index" for unit in sorted(continuation - initial)),
    ]
    assert (len(initial), len(continuation), len(set(named))) == (2251, 2623, 2623)
    return [
        _worker_case(
            f"alphabet-requisition-{group}", "requisition", f"Alphabet group {group}",
            indices=tuple(
                (name, "clinic", PARENT if name[0].isupper() else OTHER_PARENT, "child")
                for name in named[start:start + GROUP_SIZE]
            ),
        )
        for group, start in enumerate(range(0, len(named), GROUP_SIZE))
    ]


def _post_case_rows(state, app_id, form, worker, database, label):
    """Post standard case XML through the signed stock receiver."""
    data = etree.Element(f"{{{form.xmlns}}}data", nsmap={None: form.xmlns})
    for row in database.cases:
        data.append(etree.fromstring(formplayer_hq.case_block(row, database).encode("utf-8")))
    meta = etree.SubElement(data, f"{{{JR}}}meta", nsmap={None: JR})
    for key, value in {
        "instanceID": f"uuid:{label}",
        "userID": worker.user_id,
        "username": worker.username,
        "timeStart": "2025-12-01T08:00:00Z",
        "timeEnd": "2025-12-01T08:00:01Z",
    }.items():
        etree.SubElement(meta, f"{{{JR}}}{key}").text = value
    request = connect_hq.device_request(
        connect_hq.receiver_url(state.domain, app_id),
        worker.username, formplayer_hq.PASSWORD, etree.tostring(data, encoding="utf-8"),
    )
    status, response = _ask(state, request, label)
    assert status == 201, (status, response[:300])


def _core_read(core_runner, restore, expressions):
    return core_runner.evaluate(
        formBase64=base64.b64encode(LOOKUP_FORM).decode(),
        restoreBase64=base64.b64encode(restore).decode(),
        expressions=expressions,
        instances=["casedb"],
    )["values"]


def test_entire_shared_advanced_alphabet_survives_signed_receiver_restore_and_core(hq, core_runner):
    from corehq.apps.app_manager.xform import make_case_elem
    from corehq.form_processor.models import CommCareCase

    requested = _sweep_rows()
    assert len(requested) == 21
    assert max(len(row.indices) for row in requested) == GROUP_SIZE
    control = _worker_case(
        "unicode-combining-control", "requisition", "Combining mark control",
        indices=((COMBINING_INDEX, "clinic", PARENT, "child"),),
    )
    unrelated = _worker_case(
        OTHER_WORKER_CASE, "requisition", "Same link held by a different worker",
        owner="not-the-restore-worker", indices=(("ΩprobeΩ", "clinic", PARENT, "child"),),
    )
    with (
        hq_check(Configuration(privileges={"CHILD_CASES"})) as (state, _),
        hq_redis.shared(None),
        state.committing(),
    ):
        hq_redis.flush()
        app_id = publish_hq_app(state, ADVANCED_APP)
        form = operations.held_app(state, app_id).modules[1].forms[1]
        initial = _worker_database(
            _worker_case(PARENT, "clinic", "Selected clinic"),
            _worker_case(OTHER_PARENT, "clinic", "Other clinic"),
        )
        formplayer_hq.default_roles(state)
        worker = formplayer_hq.create_worker(state, initial)
        formplayer_hq.save_cases(state, initial, worker)
        _post_case_rows(
            state, app_id, form, worker, _worker_database(*requested, control, unrelated),
            "f9feb290-6a09-4abe-9c6c-9386faeb1852",
        )
        restore = _authenticated_restore(state, app_id, worker, "full-alphabet-fresh")
        wire = etree.fromstring(restore)
        assert wire.find(f"{{{CASE}}}case[@case_id='{OTHER_WORKER_CASE}']") is None
        for row in [*requested, control]:
            expected = {name: target for name, _, target, _ in row.indices}
            saved = CommCareCase.objects.get_case(row.case_id, state.domain)
            assert saved.owner_id == worker.user_id
            assert {index.identifier: index.referenced_id for index in saved.indices} == expected
            touched = wire.find(f"{{{CASE}}}case[@case_id='{row.case_id}']")
            assert touched is not None
            assert {etree.QName(index).localname: index.text for index in touched.find(f"{{{CASE}}}index")} == expected

        # The actual worker reads one named index for each name, preserving the
        # alternate parent IDs even when uppercase and lowercase neighbors exist.
        for row in requested:
            root = f"instance('casedb')/casedb/case[@case_id = '{row.case_id}']/index"
            paths = {f"{root}/{name}": target for name, _, target, _ in row.indices}
            expected = {**paths, **{f"count({path})": "1" for path in paths}}
            found = _core_read(core_runner, restore, list(expected))
            assert {value["expression"]: value.get("value") for value in found} == expected, row.case_id

        cases = "instance('casedb')/casedb/case"
        forbidden = f"count({cases}[@case_id = '{OTHER_WORKER_CASE}'])"
        wrong_spelling = f"count({cases}[@case_id = '{requested[0].case_id}']/index/a-not-written)"
        outside_lexer = f"{cases}[@case_id = '{control.case_id}']/index/{COMBINING_INDEX}"
        denied, absent, probe = _core_read(core_runner, restore, [forbidden, wrong_spelling, outside_lexer])
        assert denied["value"] == absent["value"] == "0"
        assert probe.get("error") and "value" not in probe
        for name in ("µprobe", "my:parent", "bad\u0003name"):
            try:
                make_case_elem(name)
            except ValueError:
                continue
            raise AssertionError(f"HQ constructed a non-NCName: {name!r}")

    summary = {"groups": len(requested), "names": sum(len(row.indices) for row in requested)}
    write_evidence("advanced-index-signed-full-alphabet", summary)
    print(json.dumps(summary))
