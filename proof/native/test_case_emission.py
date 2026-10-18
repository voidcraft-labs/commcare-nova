"""HQ's case lowering keeps what Nova's case exports write, and the forms it regenerates are whole.

Contract: HQ imports Nova's case exports and builds their case blocks with its
own classes, and what it builds keeps Nova's meaning: both extension indices
of each scenario with their exact attributes, the redundant subcase blocks
Nova marks ``never`` inactive (``relevant="false()"``), the new-case datums
HQ allocates (all ``uuid()``, with the registration link matching the first
new extension), the owner preload, the worker-record writes with the
usercase datum and its assertion as the local suite carries them (known
XPath carriers compare as HQ's parser's complete expression trees), and whole
capture and operation forms free of editor attributes, which Core then runs
(``CaseCaptureRuntimeTest``, ``CaseOperationRuntimeTest``), each operation
form's blocks inside one ``nova_operations`` group whose body control HQ
keeps. The local form's case blocks stand where HQ's build puts them
(``xform.py::XForm._create_casexml``): the data node's children, and each
repeat item's that holds a case block, in the order HQ's regenerated form
holds them, every subcase before the form's own case, and a single repeat
subcase's block first in its item; and each block's ``<update>`` and
``<attachment>`` children in HQ's name order
(``xform.py::XFormCaseBlock.add_case_updates``). The plausible failures: HQ's basic case
builder dropping ``relationship="extension"`` (it ignores
``OpenSubCaseAction.relationship``), an active redundant transaction, a datum
allocation or link match that no longer lines up with Nova's suite, a
regenerated form Core cannot run, a group HQ's form builder reads as a Hidden
Value because no control names it, and a local block in another place than
HQ's, which Core applies in another order (``XmlFormRecordProcessor.process``),
and a local update whose properties stand in another order than HQ's.

The relation-instance forms HQ regenerates for ``RelationInstanceRuntimeTest``
have no HQ check of their own: the checks publish and build those documents
(``proof/checks/bar.py``) and hold each write their operation makes to a case
block of the form HQ built (``proof/checks/intent.py``).
"""

import json

from lxml import etree

from proof.native.hq_support import (
    attributes,
    hq_commit,
    hq_source_hashes,
    parse_xml_xpaths,
    sha256,
    write_evidence,
)
from proof.native.steps.case_emission import NAMESPACES, NATIVE_FILES

FAMILIES = ("case",)
OWNER_PRELOAD = "instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/@owner_id"
VELLUM = '//@*[namespace-uri()="http://commcarehq.org/xforms/vellum"]'
BODY = {"h": "http://www.w3.org/1999/xhtml"}


def _data(tree):
    """The form's data node: the first child of its primary instance."""
    (data,) = tree.xpath("//x:model/x:instance[not(@src)]/*", namespaces=NAMESPACES)
    return data


def _names(element, left_out=()):
    """The local names of ``element``'s child elements, in document order, but those ``left_out`` names."""
    return [
        etree.QName(child).localname
        for child in element
        if isinstance(child.tag, str) and etree.QName(child).localname not in left_out
    ]


def _child_orders(tree):
    """The order of the children of the data node and of every element between it and a case block, each by the
    element's path below the data node (the data node's own is ``""``)."""
    data = _data(tree)
    orders = {"": _names(data)}
    for block in data.iter(f"{{{NAMESPACES['cx']}}}case"):
        above = list(block.iterancestors())
        below = above[: above.index(data)]
        for depth, element in enumerate(below):
            path = "/".join(etree.QName(step).localname for step in reversed(below[depth:]))
            orders[path] = _names(element)
    return orders


def _write_orders(tree):
    """The children of each case block's ``<update>`` and ``<attachment>``, one entry per block, sorted. A block HQ
    disables (``relevant="false()"``) is left out: it is an inert subcase the local form does not write (defect 24).
    The local form names and places a repeat's one remaining subcase as HQ does a single one (``case``, first in its
    item) where HQ numbers it among the inert ones, so blocks are matched by what they write, not by path or place."""
    data = _data(tree)
    disabled = set(tree.xpath('//x:model/x:bind[@relevant="false()"]/@nodeset', namespaces=NAMESPACES))
    orders = []
    for block in data.iter(f"{{{NAMESPACES['cx']}}}case"):
        steps = [etree.QName(step).localname for step in reversed(list(block.iterancestors()))]
        path = "/" + "/".join([*steps[steps.index(etree.QName(data).localname) :], "case"])
        if path in disabled:
            continue
        orders.append(
            {
                part: _names(element)
                for part in ("update", "attachment")
                for element in block.findall(f"cx:{part}", NAMESPACES)
            }
        )
    return sorted(orders, key=lambda order: json.dumps(order, sort_keys=True))


def _same_write_orders(record):
    """HQ's regenerated form's write orders, once each local ``<update>`` and ``<attachment>`` lists its children as
    HQ's build writes them (``xform.py::XFormCaseBlock.add_case_updates``, in name order)."""
    native = _write_orders(etree.fromstring(record["native"]))
    assert _write_orders(etree.fromstring(record["local"])) == native, (record["scenario"], native)
    return native


def _expected_datum_ids(scenario):
    if scenario == "multiple-repeat":
        return []
    if scenario in ("repeat", "query"):
        return ["case_id_new_patient_0"]
    offset = int(scenario == "registration")
    return (["case_id_new_patient_0"] if offset else []) + [
        f"case_id_new_{name}_{i + offset}" for i, name in enumerate(["episode", "visit", "consent"])
    ]


def _check_extension(record):
    scenario = record["scenario"]
    if scenario == "followup":
        assert record["ownerPreloadValues"] == [OWNER_PRELOAD]
    tree = etree.fromstring(record["native"])
    local = etree.fromstring(record["local"])
    indexes = tree.xpath('//cx:index/*[@relationship="extension"]', namespaces=NAMESPACES)
    local_indexes = local.xpath('//cx:index/*[@relationship="extension"]', namespaces=NAMESPACES)
    assert len(indexes) == len(local_indexes) == 2, scenario
    assert [dict(node.attrib) for node in indexes] == [dict(node.attrib) for node in local_indexes], scenario
    disabled = tree.xpath('//x:model/x:bind[@relevant="false()"]/@nodeset', namespaces=NAMESPACES)
    prefix = "/data/records/item" if scenario == "query" else "/data/records" if scenario == "repeat" else "/data"
    expected_disabled = (
        [] if scenario in ("multiple", "multiple-repeat") else [f"{prefix}/subcase_0/case", f"{prefix}/subcase_2/case"]
    )
    assert disabled == expected_disabled, (scenario, disabled)
    # The data node's children in HQ's order: ``_create_casexml`` writes no meta block, and the subcase blocks HQ
    # disables are the inert ones Nova's local form leaves out (defect 24).
    inert = {path.split("/")[2] for path in disabled if path.count("/") == 3}
    order = _names(_data(tree), inert)
    assert _names(_data(local), {"meta"}) == order, (scenario, order)
    expected_ids = _expected_datum_ids(scenario)
    assert record["datumIds"] == expected_ids, scenario
    assert all(function == "uuid()" for function in record["datumFunctions"]), scenario
    if scenario == "registration":
        assert record["linkSourceId"] is not None
        assert record["linkSourceId"] == "case_id_new_episode_1"
    return {
        "scenario": scenario,
        "inputSha256": record["inputSha256"],
        "extensionIndexes": [dict(node.attrib) for node in indexes],
        "disabledNativeTransactions": disabled,
        "nativeCreateDatums": expected_ids,
        "nativeLinkSourceId": record["linkSourceId"],
        "nativeOwnerPreload": (record["ownerPreloadValues"] or [None])[0],
        "nativeDataOrder": order,
        "nativeWriteOrders": _same_write_orders(record),
    }


def _worker_binds(tree, parsed):
    return [
        attributes(bind, parsed)
        for bind in sorted(
            tree.xpath('//x:model/x:bind[starts-with(@nodeset, "/data/commcare_usercase/")]', namespaces=NAMESPACES),
            key=lambda bind: bind.attrib["nodeset"],
        )
    ]


def _check_worker(record):
    scenario = record["scenario"]
    native = etree.fromstring(record["native"])
    local = etree.fromstring(record["local"])
    suite = etree.fromstring(record["suite"])
    entries = suite.xpath("entry[form=$xmlns]", xmlns=record["xmlns"])
    assert len(entries) == 1, scenario
    entry = entries[0]
    datums = record["datums"]
    assert len(datums) == 1 and datums[0]["id"] == "usercase_id" and datums[0]["requiresSelection"] is False, scenario
    carriers = [
        *(
            bind
            for tree in (native, local)
            for bind in tree.xpath(
                '//x:model/x:bind[starts-with(@nodeset, "/data/commcare_usercase/")]', namespaces=NAMESPACES
            )
        ),
        *entry.xpath('session/datum[@id="usercase_id"]'),
        *entry.xpath("assertions/assert"),
    ]
    parsed = parse_xml_xpaths(*carriers, values=[datums[0]["function"], record["assertionTest"]])
    assert _worker_binds(native, parsed) == _worker_binds(local, parsed), scenario
    assert len(_worker_binds(native, parsed)) == 4, scenario
    # Answer nodes inherit the primary instance's form-specific namespace.
    blocks = native.xpath(
        '//x:model/x:instance[not(@src)]/*/*[local-name()="commcare_usercase"]/cx:case', namespaces=NAMESPACES
    )
    assert len(blocks) == 1, scenario
    assert [etree.QName(child).localname for child in blocks[0]] == ["update"], scenario
    assert [etree.QName(child).localname for child in blocks[0][0]] == ["visits_done"], scenario
    assert [parsed[value]["structure"] for value in entry.xpath('session/datum[@id="usercase_id"]/@function')] == [
        parsed[datums[0]["function"]]["structure"]
    ], scenario
    assert [parsed[value]["structure"] for value in entry.xpath("assertions/assert/@test")] == [
        parsed[record["assertionTest"]]["structure"]
    ], scenario
    assert entry.xpath("assertions/assert/text/locale/@id") == [record["assertionLocaleId"]], scenario
    return {
        "scenario": scenario,
        "inputSha256": record["inputSha256"],
        "nativeWorkerBinds": _worker_binds(native, parsed),
        "nativeWorkerDatum": datums[0]["function"],
        "nativeWorkerAssertion": record["assertionTest"],
        "nativeWriteOrders": _same_write_orders(record),
    }


def _check_capture(record):
    name = record["scenario"]
    scenario = name.removeprefix("capture-")
    for tree in [etree.fromstring(record["native"]), etree.fromstring(record["local"])]:
        parent = tree.xpath("//x:model/x:instance[not(@src)]/*/cx:case", namespaces=NAMESPACES)
        assert len(parent) == (0 if scenario == "multiple" else 1), name
        if scenario in ("repeat", "query"):
            assert list(parent[0]) == [], name
        assert len(tree.xpath("//cx:attachment/cx:photo", namespaces=NAMESPACES)) == 1, name
        assert len(tree.xpath("//cx:update/cx:scan_url", namespaces=NAMESPACES)) == 1, name
        assert tree.xpath('//x:model/x:setvalue[contains(@ref,"/details/")]', namespaces=NAMESPACES) == [], name
        assert tree.xpath(VELLUM) == [], name
    return _ordered(record, scenario)


def _check_operation(record):
    name = record["scenario"]
    for xml in [record["native"], record["local"]]:
        tree = etree.fromstring(xml)
        operations = tree.xpath(
            '//x:model/x:instance[not(@src)]//*[local-name()="nova_operations"]', namespaces=NAMESPACES
        )
        assert len(operations) == 1, name
        # A group, so HQ's form builder keeps the blocks inside it: a body control names the data element.
        steps = [etree.QName(node).localname for node in operations[0].iterancestors()]
        path = "/" + "/".join([*steps[: steps.index("instance")][::-1], "nova_operations"])
        assert len(tree.xpath("//h:body//x:group[@ref=$path]", namespaces=NAMESPACES | BODY, path=path)) == 1, name
        assert tree.xpath(VELLUM) == [], name
    return _ordered(record, name.removeprefix("operation-"))


def _ordered(record, scenario):
    """The record's hashes, once the local form's case blocks stand where HQ's regenerated form puts them."""
    native = _child_orders(etree.fromstring(record["native"]))
    assert _child_orders(etree.fromstring(record["local"])) == native, (record["scenario"], native)
    return {
        **_hashes(record, scenario),
        "nativeChildOrders": native,
        "nativeWriteOrders": _same_write_orders(record),
    }


def _hashes(record, scenario):
    return {
        "scenario": scenario,
        "inputSha256": record["inputSha256"],
        "nativeFormSha256": sha256(record["native"]),
        "localFormSha256": sha256(record["local"]),
    }


def test_hq_keeps_extension_indices_datums_worker_writes_and_whole_case_forms(native):
    result = native.step("case")
    evidence = {
        "hqCommit": hq_commit(),
        "nativeSourceSha256": hq_source_hashes(NATIVE_FILES),
        "evidence": [_check_extension(record) for record in result["extensions"]],
        "workerEvidence": [_check_worker(record) for record in result["workers"]],
        "captureEvidence": [_check_capture(record) for record in result["captures"]],
        "operationEvidence": [_check_operation(record) for record in result["operations"]],
    }
    write_evidence(native.family("case"), "case-emission", evidence)
