"""HQ's case lowering keeps what Nova's case exports write, and the forms it regenerates are whole.

Contract: HQ imports Nova's case exports and builds their case blocks with its
own classes, and what it builds keeps Nova's meaning: both extension indices
of each scenario with their exact attributes, the redundant subcase blocks
Nova marks ``never`` inactive (``relevant="false()"``), the new-case datums
HQ allocates (all ``uuid()``, with the registration link matching the first
new extension), the owner preload, the worker-record writes with the
usercase datum and its assertion as the local suite carries them, and whole
capture and operation forms free of editor attributes, which Core then runs
(``CaseCaptureRuntimeTest``, ``CaseOperationRuntimeTest``). The plausible
failures: HQ's basic case builder dropping ``relationship="extension"`` (it
ignores ``OpenSubCaseAction.relationship``), an active redundant transaction,
a datum allocation or link match that no longer lines up with Nova's suite,
and a regenerated form Core cannot run.

The relation-instance forms HQ regenerates for ``RelationInstanceRuntimeTest``
have no HQ check of their own: the checks publish and build those documents
(``proof/checks/bar.py``) and hold each write their operation makes to a case
block of the form HQ built (``proof/checks/intent.py``).
"""

from lxml import etree

from proof.native.hq_support import hq_commit, hq_source_hashes, sha256, write_evidence
from proof.native.steps.case_emission import NAMESPACES, NATIVE_FILES

FAMILIES = ("case",)
OWNER_PRELOAD = "instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/@owner_id"
VELLUM = '//@*[namespace-uri()="http://commcarehq.org/xforms/vellum"]'


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
    }


def _worker_binds(tree):
    return sorted(
        [
            dict(bind.attrib)
            for bind in tree.xpath(
                '//x:model/x:bind[starts-with(@nodeset, "/data/commcare_usercase/")]', namespaces=NAMESPACES
            )
        ],
        key=lambda bind: bind["nodeset"],
    )


def _check_worker(record):
    scenario = record["scenario"]
    native = etree.fromstring(record["native"])
    local = etree.fromstring(record["local"])
    assert _worker_binds(native) == _worker_binds(local), scenario
    assert len(_worker_binds(native)) == 4, scenario
    # Answer nodes inherit the primary instance's form-specific namespace.
    blocks = native.xpath(
        '//x:model/x:instance[not(@src)]/*/*[local-name()="commcare_usercase"]/cx:case', namespaces=NAMESPACES
    )
    assert len(blocks) == 1, scenario
    assert [etree.QName(child).localname for child in blocks[0]] == ["update"], scenario
    assert [etree.QName(child).localname for child in blocks[0][0]] == ["visits_done"], scenario
    datums = record["datums"]
    assert len(datums) == 1 and datums[0]["id"] == "usercase_id" and datums[0]["requiresSelection"] is False, scenario
    suite = etree.fromstring(record["suite"])
    entries = suite.xpath("entry[form=$xmlns]", xmlns=record["xmlns"])
    assert len(entries) == 1, scenario
    entry = entries[0]
    assert entry.xpath('session/datum[@id="usercase_id"]/@function') == [datums[0]["function"]], scenario
    assert entry.xpath("assertions/assert/@test") == [record["assertionTest"]], scenario
    assert entry.xpath("assertions/assert/text/locale/@id") == [record["assertionLocaleId"]], scenario
    return {
        "scenario": scenario,
        "inputSha256": record["inputSha256"],
        "nativeWorkerBinds": _worker_binds(native),
        "nativeWorkerDatum": datums[0]["function"],
        "nativeWorkerAssertion": record["assertionTest"],
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
    return _hashes(record, scenario)


def _check_operation(record):
    name = record["scenario"]
    for xml in [record["native"], record["local"]]:
        tree = etree.fromstring(xml)
        operations = tree.xpath(
            '//x:model/x:instance[not(@src)]//*[local-name()="__nova_operations"]', namespaces=NAMESPACES
        )
        assert len(operations) == 1, name
        assert tree.xpath(VELLUM) == [], name
    return _hashes(record, name.removeprefix("operation-"))


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
