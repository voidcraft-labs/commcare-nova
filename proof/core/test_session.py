"""Scripted sessions: the traces are faithful, repeatable and replayable.

The contracts (plan work item 3, and its "Tests and the boundaries they earn"
row for the runner):

- a derived script opens every command every menu shows, and at each case list
  takes the first case in Core's order, by case id;
- the same session on the same inputs gives the same trace, and replaying the
  derived script gives it again;
- a trace does not omit a difference: the same app with one answer path
  altered in one form, with one case detail field changed, or with a different
  id authored in a form, gives a different trace for the runs that pass there,
  and only for them (the negative controls);
- a choice a screen cannot take is recorded in the trace, not raised;
- Core's refusal of a submission is recorded where Core constructed it, so two
  refusals one static factory builds are two sites;
- a case search is answered with every case of the requested type, and a
  claim and its sync are recorded;
- values the runtime generates are marked, consistently, wherever they occur,
  and values an app authors are not;
- the answer table's dates satisfy the date constraints HQ-built forms carry;
- the trace carries the profile's required version and properties.

The apps are real: basic.ccz, which HQ built, with the restore Core's CLI
tests use, Core's session test app with case search and case claims, and the
archives HQ built for Android's instrumentation tests.
"""

from __future__ import annotations

import copy
import zipfile

import pytest
from lxml import etree

from proof.core.artifacts import (
    BASIC_APP,
    BASIC_RESTORE,
    SESSION_APP,
    SESSION_RESTORE,
    TEMPLATE_RESTORE,
    XFORMS,
    XHTML,
    archive_variant,
    core_site,
    form_xmlns,
    read_archive_entry,
    self_check_archives,
)
from proof.core.client import CoreRunner

CASE_XMLNS = "http://commcarehq.org/case/transaction/v2"


@pytest.fixture(scope="module")
def basic_trace(core_runner, basic_app):
    return core_runner.session(basic_app, restore=BASIC_RESTORE.read_bytes())


def screens(run: dict, kind: str) -> list[dict]:
    return [step for step in run["trace"] if step.get("screen") == kind]


def form_step(run: dict) -> dict | None:
    forms = screens(run, "form")
    return forms[-1] if forms else None


def commands(run: dict) -> list[str]:
    return [step["command"] for step in run["script"] if "command" in step]


def replay(core_runner: CoreRunner, archive, runs: list[dict]) -> list[dict]:
    """The runs' scripts replayed on another build of the app."""
    report = core_runner.admit(archive)
    assert report["admitted"], report["problems"]
    try:
        trace = core_runner.session(
            report["app"], restore=BASIC_RESTORE.read_bytes(), script=[run["script"] for run in runs]
        )
    finally:
        core_runner.release(report["app"])
    return trace["runs"]


def changed_runs(before: list[dict], after: list[dict]) -> list[int]:
    return [index for index, (one, other) in enumerate(zip(before, after, strict=True)) if one != other]


def form_entries(archive) -> dict[str, str]:
    """The archive's forms by xmlns: the XML namespace of each form's instance data."""
    with zipfile.ZipFile(archive) as zipped:
        names = [name for name in zipped.namelist() if name.startswith("modules-") and name.endswith(".xml")]
    return {form_xmlns(read_archive_entry(archive, name)): name for name in names}


def test_the_derived_script_opens_every_command_each_menu_shows(basic_trace):
    shown, chosen = set(), set()
    for run in basic_trace["runs"]:
        for menu in screens(run, "menu"):
            shown |= {(menu["root"], choice["command"]) for choice in menu["choices"]}
            if "chosen" in menu:
                chosen.add((menu["root"], menu["chosen"]))
    assert shown
    assert shown == chosen
    assert basic_trace["derived"] is True
    assert "submitted" in {run["end"] for run in basic_trace["runs"]}


def test_a_case_list_is_chosen_from_by_case_id_in_cores_order(basic_trace):
    lists = [step for run in basic_trace["runs"] for step in screens(run, "case-list") if step.get("rows")]
    assert lists
    for step in lists:
        assert step["chosen"] == {"select": step["rows"][0]["caseId"]}


def test_the_same_session_twice_gives_the_same_trace(core_runner, basic_app, basic_trace):
    again = core_runner.session(basic_app, restore=BASIC_RESTORE.read_bytes())
    assert again == basic_trace


@pytest.mark.parametrize("archive", self_check_archives(), ids=lambda archive: archive.name)
def test_sessions_over_every_hq_built_archive_repeat_exactly(core_runner, archive):
    """The self-check apps: the same derived session twice gives the same trace, whatever the app does."""
    report = core_runner.admit(archive)
    assert report["admitted"], report["problems"]
    try:
        first = core_runner.session(report["app"], restore=TEMPLATE_RESTORE.read_bytes())
        second = core_runner.session(report["app"], restore=TEMPLATE_RESTORE.read_bytes())
    finally:
        core_runner.release(report["app"])
    assert first["runs"]
    assert first == second


def test_the_derived_script_replays_to_the_same_trace(core_runner, basic_app, basic_trace):
    script = [run["script"] for run in basic_trace["runs"]]
    replayed = core_runner.session(basic_app, restore=BASIC_RESTORE.read_bytes(), script=script)
    assert replayed["derived"] is False
    assert replayed["runs"] == basic_trace["runs"]


def test_the_trace_carries_the_profiles_required_version_and_properties(basic_trace):
    profile = etree.fromstring(read_archive_entry(BASIC_APP, "profile.ccpr"))
    assert basic_trace["profile"]["requiredVersion"] == {
        name: profile.get(name) for name in ("requiredMajor", "requiredMinor", "requiredMinimal")
    }
    assert {(prop["key"], prop["value"]) for prop in basic_trace["profile"]["properties"]} == {
        (prop.get("key"), prop.get("value")) for prop in profile.iter("property")
    }


def element_paths(root: etree._Element) -> dict[str, list[etree._Element]]:
    """Each element under root by the absolute path its element names make, as Core's paths name them."""
    paths: dict[str, list[etree._Element]] = {}

    def walk(element: etree._Element, prefix: str) -> None:
        path = f"{prefix}/{etree.QName(element).localname}"
        paths.setdefault(path, []).append(element)
        for child in element.iterchildren(etree.Element):
            walk(child, path)

    walk(root, "")
    return paths


def alter_answer_path(form_bytes: bytes, data_path: str) -> tuple[bytes, str] | None:
    """The form with the question Core reports at data_path stored under a renamed instance node.

    The node is found by the path its element names make, and the control and
    the bind by the whole reference they hold, equal to Core's path for the
    question; a form that spells the reference any other way gives None. Other
    expressions reading the question are left as they are: they now read nothing,
    which can only change runs that open this form.
    """
    form = etree.fromstring(form_bytes)
    data = form.find(f"{{{XHTML}}}head/{{{XFORMS}}}model/{{{XFORMS}}}instance")[0]
    nodes = element_paths(data).get(data_path, [])
    controls = [element for element in form.find(f"{{{XHTML}}}body").iter() if element.get("ref") == data_path]
    binds = [element for element in form.iter(f"{{{XFORMS}}}bind") if element.get("nodeset") == data_path]
    if len(nodes) != 1 or nodes[0] is data or len(nodes[0]) or len(controls) != 1 or len(binds) > 1:
        return None
    node = nodes[0]
    parent_path = next(path for path, elements in element_paths(data).items() if node.getparent() in elements)
    name = f"{etree.QName(node).localname}_altered"
    node.tag = etree.QName(etree.QName(node).namespace, name).text
    altered = f"{parent_path}/{name}"
    for element in controls:
        element.set("ref", altered)
    for element in binds:
        element.set("nodeset", altered)
    return etree.tostring(form), altered


def test_one_altered_answer_path_changes_the_runs_that_reach_it_and_no_others(core_runner, basic_trace, tmp_path):
    """The negative control: a trace that dropped question paths or the submission would show no difference."""
    forms = form_entries(BASIC_APP)
    for run in basic_trace["runs"]:
        if run["end"] != "submitted":
            continue
        xmlns = form_step(run)["xmlns"]
        questions = [event["dataPath"] for event in form_step(run)["events"] if event.get("event") == "question"]
        found = next(
            (
                (path, result)
                for path in questions
                if (result := alter_answer_path(read_archive_entry(BASIC_APP, forms[xmlns]), path))
            ),
            None,
        )
        if found:
            break
    else:
        raise AssertionError("no question of a submitted basic.ccz form names its path the way Core reports it")
    path, (altered_form, altered_path) = found

    after = replay(
        core_runner,
        archive_variant(BASIC_APP, tmp_path / "altered.ccz", {forms[xmlns]: altered_form}),
        basic_trace["runs"],
    )

    def reaches(run: dict) -> bool:
        form = form_step(run)
        return bool(form) and form["xmlns"] == xmlns and path in [e.get("dataPath") for e in form.get("events", [])]

    touching = [index for index, run in enumerate(basic_trace["runs"]) if reaches(run)]
    assert touching
    assert changed_runs(basic_trace["runs"], after) == touching
    for index in touching:
        paths = [event.get("dataPath") for event in form_step(after[index])["events"]]
        assert altered_path in paths
        assert path not in paths


def test_a_case_detail_is_traced_and_a_changed_detail_changes_only_its_runs(core_runner, basic_trace, tmp_path):
    """Web Apps shows the chosen case's detail; a build whose detail shows another value must trace differently."""
    restore = etree.fromstring(BASIC_RESTORE.read_bytes())
    names = {
        block.get("case_id"): block.findtext(f"{{{CASE_XMLNS}}}create/{{{CASE_XMLNS}}}case_name")
        for block in restore.iter(f"{{{CASE_XMLNS}}}case")
    }

    def detailed(run: dict) -> list[dict]:
        return [
            step
            for step in screens(run, "case-list")
            if step.get("caseDetail", {}).get("id") == "m2_case_long" and "chosen" in step
        ]

    touching = [index for index, run in enumerate(basic_trace["runs"]) if detailed(run)]
    assert touching
    for index in touching:
        for step in detailed(basic_trace["runs"][index]):
            first_tab = step["caseDetail"]["tabs"][0]
            assert first_tab["values"][0] == names[step["chosen"]["select"]]

    suite = etree.fromstring(read_archive_entry(BASIC_APP, "suite.xml"))
    detail = next(d for d in suite.iter("detail") if d.get("id") == "m2_case_long")
    detail.find("detail/field/template/text/xpath").set("function", "@case_id")
    variant = archive_variant(BASIC_APP, tmp_path / "detail.ccz", {"suite.xml": etree.tostring(suite)})
    after = replay(core_runner, variant, basic_trace["runs"])

    assert changed_runs(basic_trace["runs"], after) == touching
    for index in touching:
        for step in detailed(after[index]):
            assert step["caseDetail"]["tabs"][0]["values"][0] == step["chosen"]["select"]


def test_a_choice_the_screen_cannot_take_is_recorded(core_runner, basic_app, basic_trace):
    update = next(run for run in basic_trace["runs"] if commands(run) == ["m2", "m2-f1"])
    unknown_case = copy.deepcopy(update["script"])
    unknown_case[2] = {"select": "no-such-case"}
    unknown_command = [{"command": "no-such-command"}]
    trace = core_runner.session(
        basic_app, restore=BASIC_RESTORE.read_bytes(), script=[update["script"], unknown_case, unknown_command]
    )
    accepted, refused_case, refused_command = trace["runs"]
    assert accepted == update
    assert refused_case["end"] == "unreplayable"
    assert refused_case["trace"][-1] == {
        "screen": "case-list",
        "unreplayable": {"select": "no-such-case", "refusal": refused_case["trace"][-1]["unreplayable"]["refusal"]},
    }
    assert refused_command["end"] == "unreplayable"
    assert refused_command["trace"][-1] == {"screen": "menu", "unreplayable": {"command": "no-such-command"}}


# Core's case parser refuses a block in each of these places through InvalidStructureException's static factory,
# which takes its message from its caller (commcare-core xml/CaseXmlParserUtil.java::validateMandatoryProperty, a
# case block with an empty case id; xml/CaseXmlParser.java::loadCase, an update to a case the user's data does not
# hold), with the text on the line that calls the factory.
REFUSED_AT = {
    "empty-id": ("org/commcare/xml/CaseXmlParserUtil.java", "validateMandatoryProperty", "(error, parser)"),
    "missing-case": ("org/commcare/xml/CaseXmlParser.java", "loadCase", "Unable to update or close case"),
}


def test_a_refused_submission_is_recorded_where_core_constructed_the_refusal(core_runner, basic_trace, tmp_path):
    """basic.ccz's registration form writing an empty case id and its follow-up form updating a case the restore
    does not hold: Core refuses both with one exception class from one static factory, and the runner records each
    at the line of Core's that called the factory, so the two are two sites. The same replay twice records the
    same."""
    forms = form_entries(BASIC_APP)
    runs = {
        "empty-id": next(run for run in basic_trace["runs"] if commands(run) == ["m2", "m2-f0"]),
        "missing-case": next(run for run in basic_trace["runs"] if commands(run) == ["m2", "m2-f1"]),
    }
    edits = {}
    for refusal, (holder, reference, attribute, value) in {
        "empty-id": ("setvalue", "ref", "value", "''"),
        "missing-case": ("bind", "nodeset", "calculate", "'no-such-case'"),
    }.items():
        name = forms[form_step(runs[refusal])["xmlns"]]
        form = etree.fromstring(read_archive_entry(BASIC_APP, name))
        (element,) = [e for e in form.iter(f"{{{XFORMS}}}{holder}") if e.get(reference) == "/data/case/@case_id"]
        element.set(attribute, value)
        edits[name] = etree.tostring(form)
    report = core_runner.admit(archive_variant(BASIC_APP, tmp_path / "refused.ccz", edits))
    assert report["admitted"], report["problems"]
    scripts = [run["script"] for run in runs.values()]
    try:
        first, second = (
            core_runner.session(report["app"], restore=BASIC_RESTORE.read_bytes(), script=scripts) for _ in range(2)
        )
    finally:
        core_runner.release(report["app"])
    assert first == second
    refused = dict(zip(runs, first["runs"], strict=True))
    assert {refusal: run["end"] for refusal, run in refused.items()} == dict.fromkeys(runs, "submission-refused")
    processing = {refusal: form_step(run)["processing"] for refusal, run in refused.items()}
    assert {failure["class"] for failure in processing.values()} == {"org.javarosa.xml.util.InvalidStructureException"}
    assert {refusal: failure["site"] for refusal, failure in processing.items()} == {
        refusal: core_site(*where) for refusal, where in REFUSED_AT.items()
    }


def submitted_meta(run: dict) -> tuple[etree._Element, dict[str, str]]:
    submission = etree.fromstring(form_step(run)["submission"].encode())
    meta = {
        etree.QName(element).localname: element.text
        for element in submission.iter()
        if etree.QName(element).localname in ("instanceID", "timeStart", "timeEnd")
    }
    return submission, meta


def test_generated_values_are_marked_consistently(basic_trace):
    create = next(run for run in basic_trace["runs"] if commands(run) == ["m2", "m2-f0"])
    assert create["end"] == "submitted"
    submission, meta = submitted_meta(create)
    assert meta["timeStart"] == meta["timeEnd"] == "@clock:now"
    assert meta["instanceID"].startswith("@generated:uuid:")
    created = next(
        block for block in submission.iter(f"{{{CASE_XMLNS}}}case") if block.find(f"{{{CASE_XMLNS}}}create") is not None
    )
    case_id = created.get("case_id")
    assert case_id.startswith("@generated:uuid:") and case_id != meta["instanceID"]
    case_db = etree.fromstring(form_step(create)["caseDb"].encode())
    assert case_id in {case.get("case_id") for case in case_db.iter("case")}
    assert create["generated"]["clock"] == {"@clock:now": "2026-01-15T10:30:00.000Z", "@clock:today": "2026-01-15"}


def test_an_authored_id_is_not_taken_for_a_generated_one(core_runner, basic_trace, tmp_path):
    """Two builds that differ only in an id their form authors must trace differently; generated ids stay marked."""
    create = next(run for run in basic_trace["runs"] if commands(run) == ["m2", "m2-f0"])
    name = form_entries(BASIC_APP)[form_step(create)["xmlns"]]
    authored = ("0f8fad5b-d9cb-469f-a165-70867728950e", "7c9e6679-7425-40de-944b-e07fc1f90ae7")
    runs = []
    for index, value in enumerate(authored):
        form = etree.fromstring(read_archive_entry(BASIC_APP, name))
        data = form.find(f"{{{XHTML}}}head/{{{XFORMS}}}model/{{{XFORMS}}}instance")[0]
        etree.SubElement(data, f"{{{etree.QName(data).namespace}}}authored_id").text = value
        variant = archive_variant(BASIC_APP, tmp_path / f"authored-{index}.ccz", {name: etree.tostring(form)})
        (run,) = replay(core_runner, variant, [create])
        runs.append(run)

    assert runs[0] != runs[1]
    for run, value in zip(runs, authored, strict=True):
        assert run["end"] == "submitted"
        submission, meta = submitted_meta(run)
        assert [element.text for element in submission.iter() if etree.QName(element).localname == "authored_id"] == [
            value
        ]
        assert meta["instanceID"].startswith("@generated:uuid:")


def test_the_answer_tables_dates_satisfy_the_date_constraints_hq_forms_carry(basic_trace):
    """basic.ccz's date questions ask for a recent date, one not in the future and one in the future."""
    dated = [
        event
        for run in basic_trace["runs"]
        if form_step(run)
        for event in form_step(run).get("events", [])
        if event.get("dataType") in ("date", "dateTime")
    ]
    assert dated
    assert [event for event in dated if "unanswerable" in event] == []
    first = {"date": "@clock:today", "dateTime": "@clock:now"}
    answered = [event for event in dated if event.get("attempts")]
    assert answered
    assert [event["attempts"][0]["value"] for event in answered] == [first[event["dataType"]] for event in answered]


def person_cases(restore: bytes, case_ids: list[str]) -> bytes:
    """The restore with cases of type person added, in the restore's own case block shape."""
    root = etree.fromstring(restore)
    for case_id in case_ids:
        block = etree.SubElement(
            root,
            f"{{{CASE_XMLNS}}}case",
            case_id=case_id,
            date_modified="2014-08-04T21:09:07.000000Z",
            user_id="test_user",
        )
        create = etree.SubElement(block, f"{{{CASE_XMLNS}}}create")
        etree.SubElement(create, f"{{{CASE_XMLNS}}}case_type").text = "person"
        etree.SubElement(create, f"{{{CASE_XMLNS}}}case_name").text = f"Person {case_id}"
        etree.SubElement(create, f"{{{CASE_XMLNS}}}owner_id").text = "test_user"
    return etree.tostring(root)


def test_a_search_is_answered_with_every_case_of_its_type_and_a_claim_is_recorded(core_runner: CoreRunner):
    people = ["person-b", "person-a"]
    restore = person_cases(SESSION_RESTORE.read_bytes(), people)
    report = core_runner.admit(SESSION_APP)
    assert report["admitted"], report["problems"]
    try:
        trace = core_runner.session(report["app"], restore=restore)
        empty = core_runner.session(report["app"], restore=SESSION_RESTORE.read_bytes())
    finally:
        core_runner.release(report["app"])

    searched = next(run for run in trace["runs"] if screens(run, "search"))
    search = screens(searched, "search")[0]
    assert [request["kind"] for request in search["requests"]] == ["search"]
    assert search["requests"][0]["caseTypes"] == ["person"]
    assert search["requests"][0]["answered"] == len(people)
    listed = next(step for step in screens(searched, "multi-select-list") if step["datum"] == "search_selected_cases")
    assert {row["caseId"] for row in listed["rows"]} == set(people)
    assert listed["chosen"] == {"selectMany": [listed["rows"][0]["caseId"]]}

    claimed = next(run for run in trace["runs"] if screens(run, "sync"))
    sync = screens(claimed, "sync")[0]
    assert [request["kind"] for request in sync["requests"]] == ["post", "sync"]
    assert sync["requests"][0]["status"] == 201
    assert sync["requests"][1]["restored"] is True
    selected = screens(claimed, "case-list")[0]["chosen"]["select"]
    assert sync["requests"][0]["params"]["case_id"] == [selected]

    unsearched = next(run for run in empty["runs"] if screens(run, "search"))
    assert screens(unsearched, "search")[0]["requests"][0]["answered"] == 0
    assert unsearched["end"] == "no-cases"
