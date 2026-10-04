"""The comparators report every difference, where it is, and nothing else.

Contract: ``compare.xml_tree``, ``compare.app_strings`` and
``compare.json_tree`` report the complete set of differences between two
artifacts, each at its structural path, and report none between two
spellings a consumer reads alike (attribute order, indentation, comments).
One symptom has one structural path wherever it occurs: an identity, key or
name that is the app's data is ``*`` there (its concrete value in ``at``),
and one that is CommCare's vocabulary is kept, as the format's readers decide
(``compare.names``); a collection its reader keys is compared by that key,
not by position. The plausible failures: a comparator that stops at the
first difference, one that loses a difference in a subtree it paired wrongly,
one that reports a namespace move once per element, one that treats two
XPath spellings as equal by pattern rather than leaving that to a registered
spelling rule, one that writes an element's id (a form's ``unique_id``, which
HQ re-mints) or a question's id into the structural path so a symptom cannot
be registered, one that writes a case block's parts or a guard block's
reserved name as ``*`` so two symptoms are one class, one that pairs binds,
setvalues or cases by position so one insertion changes every later one, one
that names a generated id by its draw order so one more id renames the rest,
one that merges two different profile settings into one class, one that
reports Core's refusal of a submission or an exception Core raised running a
form, and what either leaves out of the run, without its cause (or with a
value it carries in its cause), so two causes are one class (or one cause
two), and one that reports how many ids a run generated again beside the
ids themselves.

The inputs are real HQ build output: the archive HQ built that Core's own
tests install (``basic_app/basic.ccz``), each variant changing named parts,
and Core's traces of its sessions (``compare.trace``).
"""

from __future__ import annotations

import copy
import json
import re

import pytest
from lxml import etree

from proof.checks.compare.app_strings import compare_app_strings
from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.trace import compare_traces
from proof.checks.compare.xml_tree import compare_xml, parse_xml
from proof.core.artifacts import BASIC_APP, BASIC_RESTORE, archive_variant, read_archive_entry
from proof.observe.alignment import renamespace_xform
from proof.rules import RULES

SUITE = read_archive_entry(BASIC_APP, "suite.xml")
FORM = read_archive_entry(BASIC_APP, "modules-1/forms-0.xml")
# A form HQ built with a group of questions, a child case's block (``subcase_0``), the form's own case block and
# its setvalues.
CASE_FORM = read_archive_entry(BASIC_APP, "modules-9/forms-1.xml")
XF = "http://www.w3.org/2002/xforms"
CX2 = "http://commcarehq.org/case/transaction/v2"


def _xml(root):
    return etree.tostring(root, encoding="utf-8", xml_declaration=True)


def _diff(before, after, **options):
    return {
        (d.path, d.at, d.kind)
        for d in compare_xml(before, after, check="proof2", document="basic", artifact="a", **options)
    }


def test_an_unchanged_document_differs_in_nothing_a_consumer_reads():
    root = parse_xml(SUITE)
    for element in root.iter():
        if isinstance(element.tag, str) and len(element.attrib) > 1:
            items = list(element.attrib.items())
            element.attrib.clear()
            for key, value in reversed(items):  # the same attributes, in the opposite order
                element.set(key, value)
    root.insert(0, etree.Comment("a comment HQ never writes"))
    etree.indent(root, space="\t\t")
    assert _diff(SUITE, _xml(root)) == set()


def test_every_difference_in_a_suite_is_reported_at_its_path():
    root = parse_xml(SUITE)
    menus = [m for m in root if m.tag == "menu"]
    resource = root.find("xform/resource")
    resource.set("version", "9999")
    removed = menus[0].findall("command")[1]
    menus[0].remove(removed)
    etree.SubElement(menus[1], "command", id="m-added")
    form_text = root.find("entry/form")
    form_text.text = "http://openrosa.org/formdesigner/changed"
    first_menu, second_menu = menus[0].get("id"), menus[1].get("id")
    found = _diff(SUITE, _xml(root))
    assert found == {
        (
            "/suite/xform[*]/resource[@id=*]/@version",
            f"/suite/xform[1]/resource[@id={resource.get('id')}]/@version",
            "changed",
        ),
        (
            "/suite/menu[@id=*]/command[@id=*]",
            f"/suite/menu[@id={first_menu}]/command[@id={removed.get('id')}]",
            "removed",
        ),
        (
            "/suite/menu[@id=*]/command[@id=*]",
            f"/suite/menu[@id={second_menu}]/command[@id=m-added]",
            "added",
        ),
        ("/suite/entry[*]/form[*]/text()", "/suite/entry[1]/form[1]/text()", "changed"),
    }


def test_one_symptom_on_every_element_is_one_structural_path():
    """A form resource's id is the form's unique_id, which HQ's create re-mints on every run, so it is ``*``."""
    root = parse_xml(SUITE)
    resources = root.findall("xform/resource")
    assert len(resources) > 1 and len({r.get("id") for r in resources}) == len(resources)
    for resource in resources:
        resource.set("version", "9999")
    found = compare_xml(SUITE, _xml(root), check="proof2", document="basic", artifact="suite.xml")
    assert len(found) == len(resources)
    assert {d.path for d in found} == {"/suite/xform[*]/resource[@id=*]/@version"}
    assert {d.at for d in found} == {
        f"/suite/xform[{i}]/resource[@id={r.get('id')}]/@version" for i, r in enumerate(resources, start=1)
    }


def test_a_profile_setting_keeps_its_key_in_the_path():
    """A profile property's key is CommCare's setting name, so two settings are two classes."""
    profile = read_archive_entry(BASIC_APP, "profile.ccpr")
    root = parse_xml(profile)
    for key in ("cc-show-saved", "cc-autoup-freq"):
        next(p for p in root.iter("property") if p.get("key") == key).set("value", "changed")
    found = compare_xml(profile, _xml(root), check="proof3", document="basic", artifact="profile.ccpr")
    assert {(d.path, d.at) for d in found} == {
        ("/profile/property[@key=cc-show-saved]/@value", "/profile/property[@key=cc-show-saved]/@value"),
        ("/profile/property[@key=cc-autoup-freq]/@value", "/profile/property[@key=cc-autoup-freq]/@value"),
    }


def test_a_reordering_is_one_difference():
    root = parse_xml(SUITE)
    menus = [m for m in root if m.tag == "menu"]
    root.remove(menus[1])
    menus[0].addprevious(menus[1])
    found = compare_xml(SUITE, _xml(root), check="proof2", document="basic", artifact="suite.xml")
    assert [(d.path, d.kind) for d in found] == [("/suite/order()", "changed")]
    assert found[0].before.index(f"menu[@id={menus[0].get('id')}]") < found[0].before.index(
        f"menu[@id={menus[1].get('id')}]"
    )


def test_a_moved_data_namespace_is_one_difference_and_xpath_is_compared_as_written():
    moved = parse_xml(renamespace_xform(FORM, "http://openrosa.org/formdesigner/moved"))
    bind = next(b for b in moved.iter(f"{{{XF}}}bind") if b.get("constraint"))
    bind.set("constraint", bind.get("constraint").replace(" ", "  ", 1))
    found = compare_xml(FORM, _xml(moved), check="proof2", document="basic", artifact="form:1.0")
    kinds = sorted((d.path, d.at, d.kind) for d in found)
    assert kinds == [
        (
            "/html/head[*]/model[*]/bind[@nodeset=/data/*]/@constraint",
            "/html/head[1]/model[1]/bind[@nodeset=" + bind.get("nodeset") + "]/@constraint",
            "changed",
        ),
        (
            "/html/head[*]/model[*]/instance[*]/data[*]/namespace()",
            "/html/head[1]/model[1]/instance[1]/data[1]/namespace()",
            "changed",
        ),
    ]


ITEXT = (
    b'<translation lang="en"><text id="q-label"><value>Label</value>'
    b'<value form="image">jr://file/a.png</value><value form="audio">jr://file/a.mp3</value></text></translation>'
)


def test_an_itext_text_s_values_are_paired_by_their_form_so_a_reorder_changes_no_value():
    """JavaRosa reads a text's value for a form by its ``form`` attribute (``XFormParser.parseTextHandle``), so
    values reordered are one ``order()`` difference, not a change of each value at its position, and a changed
    value is named by its form in the path."""
    reordered = ITEXT.replace(
        b'<value form="image">jr://file/a.png</value><value form="audio">jr://file/a.mp3</value>',
        b'<value form="audio">jr://file/a.mp3</value><value form="image">jr://file/a.png</value>',
    )
    assert _diff(ITEXT, reordered) == {
        ("/translation/text[@id=*]/order()", "/translation/text[@id=q-label]/order()", "changed")
    }
    changed = ITEXT.replace(b"jr://file/a.png", b"jr://file/b.png")
    assert _diff(ITEXT, changed) == {
        (
            "/translation/text[@id=*]/value[@form=image]/text()",
            "/translation/text[@id=q-label]/value[@form=image]/text()",
            "changed",
        )
    }
    # The plain value has no form: it is placed by position among the values that have none.
    relabeled = ITEXT.replace(b"<value>Label</value>", b"<value>Other</value>")
    assert _diff(ITEXT, relabeled) == {
        ("/translation/text[@id=*]/value[*]/text()", "/translation/text[@id=q-label]/value[1]/text()", "changed")
    }


def test_a_document_that_does_not_parse_is_refused_not_compared():
    found = compare_xml(SUITE, SUITE[: len(SUITE) // 2], check="proof2", document="basic", artifact="suite.xml")
    assert [(d.path, d.kind, d.before is None, d.after is not None) for d in found] == [
        ("/not-well-formed", "refused", True, True)
    ]


def test_whitespace_only_text_is_compared_when_asked():
    root = parse_xml(SUITE)
    etree.indent(root, space=" ")
    assert _diff(SUITE, _xml(root)) == set()
    assert _diff(SUITE, _xml(root), blank_text="exact")


def test_every_app_strings_difference_is_reported_at_its_hq_key_family_and_comments_are_not_content():
    text = read_archive_entry(BASIC_APP, "default/app_strings.txt").decode("utf-8")
    strings = dict(line.partition("=")[::2] for line in text.splitlines() if "=" in line)
    # A family HQ derives from the app's positions, one with no placeholder, and one of CommCare's own ids.
    assert {"case_lists.m2", "case_list_form.m5", "app.display.name", "case_autoload.case.case_missing"} <= set(strings)
    changed = {**strings, "case_lists.m2": "Changed", "case_autoload.case.case_missing": "Changed"}
    del changed["case_list_form.m5"]
    assert "case_lists.m99" not in strings
    changed["case_lists.m99"] = "Added"
    lines = [f"{key}={value}" for key, value in changed.items()] + ["# a comment line"]
    found = compare_app_strings(
        text, "\n".join(lines), check="proof2", document="basic", artifact="app_strings:default"
    )
    assert {(d.path, d.at, d.kind) for d in found} == {
        ("/case_lists.m*", "/case_lists.m2", "changed"),
        ("/case_lists.m*", "/case_lists.m99", "added"),
        ("/case_list_form.m*", "/case_list_form.m5", "removed"),
        ("/case_autoload.case.case_missing", "/case_autoload.case.case_missing", "changed"),
    }
    assert (
        compare_app_strings(text, text + "\n# only a comment\n", check="proof2", document="basic", artifact="a") == []
    )


@pytest.mark.usefixtures("hq")
def test_the_key_families_the_comparison_reads_are_hqs_registry_at_the_pin():
    """The comparison runs without HQ, from the families file; a pin that moves HQ's registry fails here."""
    from proof.checks.compare.app_strings import FAMILIES_JSON, families_json, hq_key_families

    assert FAMILIES_JSON.read_text(encoding="utf-8") == families_json(hq_key_families()), (
        "proof/checks/compare/app_strings_families.json is not HQ's app strings key registry at the pin; write it"
        " again with `python -m proof.checks.compare.app_strings <path>` in the image, and review the change."
    )


def test_an_app_strings_key_is_in_its_most_specific_hq_family():
    from proof.checks.compare.app_strings import key_families, key_path

    assert len(key_families()) > 50  # every @pattern HQ registers, each read back exactly
    assert key_path("forms.m3f12") == "/forms.m*f*"
    assert key_path("forms.m3f12.icon") == "/forms.m*f*.icon"  # not forms.m%df%d.%s
    assert key_path("forms.m3f12.custom_icon_text") == "/forms.m*f*.*"
    assert key_path("m0.case_short.case_name_1.header") == "/m*.*.*_*_*.header"
    assert key_path("homescreen.title") == "/homescreen.title"
    assert key_path("home.start") == "/home.start"


def test_json_differences_are_complete_and_data_keys_are_structural():
    before = {"modules": [{"id": "a", "forms": [1, 2]}], "media": {"jr://file/a.png": {"v": 1}}}
    after = copy.deepcopy(before)
    after["modules"][0]["forms"] = [1]
    after["modules"].append({"id": "b"})
    after["media"]["jr://file/a.png"]["v"] = 2
    after["modules"][0]["id"] = 7
    found = compare_json(before, after, check="proof1", document="d", artifact="app.json", data_maps={"/media"})
    assert sorted((d.path, d.at, d.kind) for d in found) == [
        ("/media/*/v", "/media/jr:~1~1file~1a.png/v", "changed"),
        ("/modules/*", "/modules/1", "added"),
        ("/modules/*/forms/*", "/modules/0/forms/1", "removed"),
        ("/modules/*/id", "/modules/0/id", "changed"),
    ]
    assert compare_json(before, copy.deepcopy(before), check="proof1", document="d", artifact="app.json") == []


def test_two_traces_differ_only_in_the_runs_a_changed_form_reaches(core_runner, tmp_path):
    """Core traces compare as JSON: the same session is equal, and a changed label shows only where it is read."""

    def session(archive, script=None):
        report = core_runner.admit(archive)
        assert report["admitted"], report["problems"]
        try:
            return core_runner.session(report["app"], restore=BASIC_RESTORE.read_bytes(), script=script)
        finally:
            core_runner.release(report["app"])

    first = session(BASIC_APP)
    assert compare_traces(first, session(BASIC_APP), check="proof3", document="basic", rules=RULES) == []

    name = "modules-1/forms-0.xml"
    form = parse_xml(read_archive_entry(BASIC_APP, name))
    label = next(value for value in form.iter(f"{{{XF}}}value") if value.text and value.text.strip())
    label.text = "A label no build of this app shows"
    xmlns = etree.QName(next(form.iter(f"{{{XF}}}instance"))[0]).namespace
    variant = archive_variant(BASIC_APP, tmp_path / "label.ccz", {name: _xml(form)})
    after = session(variant, script=[run["script"] for run in first["runs"]])

    found = compare_traces(
        {"runs": first["runs"]}, {"runs": after["runs"]}, check="proof3", document="basic", rules=RULES
    )
    reaching = {
        str(index)
        for index, run in enumerate(first["runs"])
        if any(step.get("xmlns") == xmlns for step in run["trace"] if step.get("screen") == "form")
    }
    assert found and reaching
    assert {d.at.split("/")[2] for d in found} <= reaching
    assert all(d.path.startswith("/runs/*/") for d in found)


# Names and keys -----------------------------------------------------------------


def _model(root):
    return root.find(f"{{{etree.QName(root).namespace}}}head/{{{XF}}}model")


def _bind(root, nodeset):
    return next(b for b in _model(root).iter(f"{{{XF}}}bind") if b.get("nodeset") == nodeset)


def test_a_forms_own_names_are_one_star_and_the_names_its_readers_find_stay():
    """A question's id is the app's, however deep its group nests it, so one symptom on two questions is one class;
    a case block's parts and HQ's child case element are the readers' (Core's case parser, HQ's builder), so a
    change there keeps them, and a guard block Nova names keeps its reserved prefix without its minted part."""
    root = parse_xml(CASE_FORM)
    data = root.find(f".//{{{XF}}}instance")[0]
    namespace = etree.QName(data).namespace
    for nodeset in ("/data/questions/x", "/data/questions/y"):
        _bind(root, nodeset).set("constraint", ". >= 1")
    _bind(root, "/data/subcase_0/case/update/radius").set("calculate", "/data/questions/x")
    _bind(root, "/data/case/@user_id").set("calculate", "''")
    data.find(f"{{{namespace}}}questions/{{{namespace}}}x").set("note", "added")
    data.find(f"{{{namespace}}}subcase_0/{{{CX2}}}case/{{{CX2}}}create/{{{CX2}}}case_type").text = "other"
    etree.SubElement(data, f"{{{namespace}}}__nova_guard_1270f255_e852_5981_a7fd_9b23c7d98225_text")
    found = {(d.path, d.kind) for d in compare_xml(CASE_FORM, _xml(root), check="proof4", document="d", artifact="f")}
    model, instance = "/html/head[*]/model[*]", "/html/head[*]/model[*]/instance[*]/data[*]"
    assert found == {
        (f"{model}/bind[@nodeset=/data/*]/@constraint", "changed"),
        (f"{model}/bind[@nodeset=/data/subcase_*/case/update/*]/@calculate", "changed"),
        (f"{model}/bind[@nodeset=/data/case/@user_id]/@calculate", "changed"),
        (f"{instance}/*/@note", "added"),
        (f"{instance}/subcase_*[*]/case[*]/create[*]/case_type[*]/text()", "changed"),
        (f"{instance}/__nova_guard_*[*]", "added"),
    }
    constraints = [d for d in compare_xml(CASE_FORM, _xml(root), check="proof4", document="d", artifact="f")]
    assert sorted(d.at for d in constraints if d.path.endswith("@constraint")) == [
        "/html/head[1]/model[1]/bind[@nodeset=/data/questions/x]/@constraint",
        "/html/head[1]/model[1]/bind[@nodeset=/data/questions/y]/@constraint",
    ]


def test_a_setvalue_is_paired_by_its_event_and_target_so_one_more_moves_no_other():
    """Core reads a setvalue for its event and target (``XFormParser.parseSetValueAction``), never its position: a
    save that adds one before the others is that one addition, where pairing by position changed every later one."""
    root = parse_xml(CASE_FORM)
    model = _model(root)
    first = next(model.iter(f"{{{XF}}}setvalue"))
    first.addprevious(etree.Element(f"{{{XF}}}setvalue", event="jr-insert", ref="/data/questions/@count", value="1"))
    found = compare_xml(CASE_FORM, _xml(root), check="proof4", document="d", artifact="f")
    assert [(d.path, d.at, d.kind) for d in found] == [
        (
            "/html/head[*]/model[*]/setvalue[@event=jr-insert][@ref=/data/*/@count]",
            "/html/head[1]/model[1]/setvalue[@event=jr-insert][@ref=/data/questions/@count]",
            "added",
        )
    ]
    reordered = parse_xml(CASE_FORM)
    model = _model(reordered)
    setvalues = list(model.iter(f"{{{XF}}}setvalue"))
    model.remove(setvalues[-1])
    setvalues[0].addprevious(setvalues[-1])
    assert [
        (d.path, d.kind) for d in compare_xml(CASE_FORM, _xml(reordered), check="proof4", document="d", artifact="f")
    ] == [("/html/head[*]/model[*]/order()", "changed")]


SUBMISSION = (
    '<data xmlns="http://openrosa.org/formdesigner/F" xmlns:jrm="http://dev.commcarehq.org/jr/xforms">'
    "<questions><x>{x}</x><group><y>2</y></group></questions>"
    '<subcase_0><case xmlns="http://commcarehq.org/case/transaction/v2" case_id="@generated:uuid:{child}">'
    "<create><case_name>{name}</case_name><case_type>point</case_type></create>"
    '<update><radius>3</radius></update><index><parent case_type="host">parent-1</parent></index></case></subcase_0>'
    '<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="parent-1"><update><x>{x}</x></update></case>'
    '<orx:meta xmlns:orx="http://openrosa.org/jr/xforms"><orx:instanceID>@generated:uuid:{instance}</orx:instanceID>'
    "</orx:meta></data>"
)


def _form_run(x="1", name="proof", child=1, instance=2, end="submitted", cases=None):
    submission = SUBMISSION.format(x=x, name=name, child=child, instance=instance)
    step = {"screen": "form", "submission": submission}
    if cases is not None:
        step["caseDb"] = "<casedb>" + "".join(cases) + "</casedb>"
    return _counted({"end": end, "script": [], "trace": [{"screen": "menu"}, step]})


def _counted(run):
    """A run with the count of generated ids the runner keeps beside it: how many marks it holds
    (``Generated.java::mark``)."""
    marks = set(re.findall(r"@generated:uuid:[0-9]+", json.dumps(run)))
    return {**run, "generated": {"uuids": len(marks), "seed": 20260930}}


def _case(case_id, case_type="point", **properties):
    children = "".join(f"<{name}>{value}</{name}>" for name, value in properties.items())
    return (
        f'<case case_id="{case_id}" case_type="{case_type}" status="open" owner_id="w">'
        f"<case_name>proof</case_name><date_opened>today</date_opened><last_modified>today</last_modified>"
        f"{children}<index/><attachment/></case>"
    )


def _found(before, after):
    return compare_traces({"runs": before}, {"runs": after}, check="proof3", document="d", rules=())


def _paths(before, after):
    return {(d.path, d.kind) for d in _found(before, after)}


def test_a_submissions_question_ids_are_the_apps_and_its_case_blocks_and_metadata_are_the_readers():
    """In a run's submission, questions and groups at any depth are one ``*``; the case block, its create, update
    and index, a case's own fields and HQ's ``subcase_<n>`` keep their names, a case property is ``*``."""
    assert _paths([_form_run()], [_form_run(x="9", name="other")]) == {
        ("/runs/*/trace/*/submission/data/*/text()", "changed"),
        ("/runs/*/trace/*/submission/data/subcase_*[*]/case[*]/create[*]/case_name[*]/text()", "changed"),
        ("/runs/*/trace/*/submission/data/case[*]/update[*]/*/text()", "changed"),
    }
    assert _paths([_form_run(end="submitted")], [_form_run(end="form-error")]) == {
        ("/runs/*/end/submitted/form-error", "changed")
    }


def test_core_s_case_database_is_keyed_by_case_id():
    """Core keys its case database by ``@case_id``: one case more is that one case, never every later case's
    attributes, and a property is ``*`` where Core's own children keep their names."""
    cases = [_case("a"), _case("b", note="x"), _case("c")]
    more = [_case("a"), _case("new"), _case("b", note="y"), _case("c")]
    assert _paths([_form_run(cases=cases)], [_form_run(cases=more)]) == {
        ("/runs/*/trace/*/caseDb/casedb/case[@case_id=*]", "added"),
        ("/runs/*/trace/*/caseDb/casedb/case[@case_id=*]/*/text()", "changed"),
    }


def test_a_generated_id_is_named_by_the_first_place_both_runs_hold_it():
    """The runner numbers generated ids as it draws them, so the same ids drawn in another order renumber them;
    named by the first place both runs hold one, they compare equal, and one id where the other run used two is
    still a difference. A case block written elsewhere keeps its case's name through the case database both runs
    hold, so only the move differs."""
    cases = [_case("@generated:uuid:1")]
    assert (
        _paths([_form_run(cases=cases)], [_form_run(child=2, instance=1, cases=[_case("@generated:uuid:2")])]) == set()
    )
    # One id at two places where the other run made two: the identity between them changed, and that differs
    # where the second id was; how many ids each run made is that difference again, and is not reported.
    shared = _form_run(child=2, instance=2, cases=[_case("@generated:uuid:2")])
    assert (_form_run(cases=cases)["generated"]["uuids"], shared["generated"]["uuids"]) == (2, 1)
    assert _paths([_form_run(cases=cases)], [shared]) == {
        ("/runs/*/trace/*/submission/data/meta[*]/instanceID[*]/text()", "changed")
    }
    moved = _form_run(cases=cases)
    moved["trace"][1]["submission"] = moved["trace"][1]["submission"].replace("subcase_0", "records")
    assert _paths([_form_run(cases=cases)], [moved]) == {
        ("/runs/*/trace/*/submission/data/subcase_*[*]", "removed"),
        ("/runs/*/trace/*/submission/data/*", "added"),
    }


def test_a_translated_field_is_keyed_by_language_whatever_languages_it_holds():
    """HQ declares its translated fields by schema (``LabelProperty``), and its own save may hold a language the
    app does not (``Detail.no_items_text``'s default ``en``), so the field's keys are ``*`` all the same; an object
    HQ's schema does not name keeps its keys unless they are only the app's languages."""
    from proof.checks.compare.app_json import DATA_MAPS, language_maps

    detail = {"no_items_text": {"es": "Vacío"}, "custom_variables": {"es": "x"}, "other": {"en": "y"}}
    edited = {"no_items_text": {"es": "Vacío", "en": "List is empty."}, "custom_variables": {"es": "z"}, "other": {}}
    # HQ's save holds its default language on both sides: the field is still keyed by language.
    held = {"select_text": {"es": "Seguir", "en": "Continue"}}
    resaved = {"select_text": {"es": "Continuar", "en": "Continue"}}
    before = {"modules": [{"case_details": {"short": detail, "long": held}}]}
    after = {"modules": [{"case_details": {"short": edited, "long": resaved}}]}
    maps = language_maps(before, "", {"es"}, set(DATA_MAPS))
    language_maps(after, "", {"es"}, maps)
    found = compare_json(before, after, check="proof4", document="d", artifact="app.json", data_maps=frozenset(maps))
    assert {(d.path, d.kind) for d in found} == {
        ("/modules/*/case_details/short/no_items_text/*", "added"),
        ("/modules/*/case_details/short/custom_variables/*", "changed"),
        ("/modules/*/case_details/short/other/en", "removed"),
        ("/modules/*/case_details/long/select_text/*", "changed"),
    }


def _with_query_rows(form):
    """HQ's case form with a query-bound repeat in its group whose row holds another (Vellum's model iteration:
    each repeat's ``ids``, ``count`` and ``current_index``, each row an ``item`` with its ``id`` and ``index``,
    ``src/modeliteration.js``), a question in each row, each repeat's ``current_index`` bind and each row's
    ``jr-insert`` setvalue."""
    root = parse_xml(form)
    model = _model(root)
    data = model.find(f"{{{XF}}}instance")[0]
    namespace = etree.QName(data).namespace

    def repeat(parent, name):
        element = etree.SubElement(parent, f"{{{namespace}}}{name}", ids="", count="", current_index="")
        return etree.SubElement(element, f"{{{namespace}}}item", id="", index="")

    outer = repeat(data.find(f"{{{namespace}}}questions"), "q")
    etree.SubElement(outer, f"{{{namespace}}}a")
    inner = repeat(outer, "r")
    etree.SubElement(inner, f"{{{namespace}}}b")
    for path in ("/data/questions/q", "/data/questions/q/item/r"):
        etree.SubElement(model, f"{{{XF}}}bind", nodeset=f"{path}/@current_index", calculate=f"count({path}/item)")
        etree.SubElement(model, f"{{{XF}}}bind", nodeset=f"{path}/item/{'a' if path.endswith('q') else 'b'}")
    return root


def test_how_many_query_bound_rows_hold_a_node_is_the_documents_and_a_row_ending_the_path_is_kept():
    """A query-bound repeat's row is part of the run of the app's names it sits in, so a repeat's count, or a
    question, one row deep and two rows deep is one class; where the row itself is the node (its ``@index``), the
    row is kept, so a row's attribute and its repeat's are two classes."""
    before = _with_query_rows(CASE_FORM)
    after = copy.deepcopy(before)
    model = _model(after)
    for path in ("/data/questions/q", "/data/questions/q/item/r"):
        _bind(after, f"{path}/@current_index").set("calculate", f"count({path}/item) + 0")
        etree.SubElement(model, f"{{{XF}}}setvalue", event="jr-insert", ref=f"{path}/item/@index", value="1")
    for nodeset in ("/data/questions/q/item/a", "/data/questions/q/item/r/item/b", "/data/questions/x"):
        _bind(after, nodeset).set("relevant", "true()")
    data = model.find(f"{{{XF}}}instance")[0]
    for row in data.iter(f"{{{etree.QName(data).namespace}}}item"):
        del row.attrib["index"]
    found = compare_xml(_xml(before), _xml(after), check="proof4", document="d", artifact="f")
    classes = {}
    for difference in found:
        classes.setdefault((difference.path, difference.kind), []).append(difference.at)
    model_path, instance = "/html/head[*]/model[*]", "/html/head[*]/model[*]/instance[*]/data[*]"
    assert {key: len(ats) for key, ats in classes.items()} == {
        (f"{model_path}/bind[@nodeset=/data/*/@current_index]/@calculate", "changed"): 2,
        (f"{model_path}/setvalue[@event=jr-insert][@ref=/data/*/item/@index]", "added"): 2,
        (f"{model_path}/bind[@nodeset=/data/*]/@relevant", "added"): 3,
        (f"{instance}/*/item[@id=*]/@index", "removed"): 2,
    }
    assert sorted(classes[(f"{model_path}/bind[@nodeset=/data/*/@current_index]/@calculate", "changed")]) == [
        f"{model_path.replace('*', '1')}/bind[@nodeset=/data/questions/q/@current_index]/@calculate",
        f"{model_path.replace('*', '1')}/bind[@nodeset=/data/questions/q/item/r/@current_index]/@calculate",
    ]


def test_a_submissions_query_bound_rows_are_part_of_the_run_they_sit_in():
    """In a submission, a question one row deep and two rows deep is one class, and so is a case block in a row
    at either depth, its row kept: a block in a row and one in the app's own group are two classes."""

    def submission(value):
        block = f'<case xmlns="{CX2}" case_id="c-{{row}}"><update><p>{value}</p></update></case>'
        return (
            '<data xmlns="http://openrosa.org/formdesigner/F"><q><item id="r1">'
            f'<a>{value}</a>{block.format(row=1)}<r><item id="r2"><b>{value}</b>{block.format(row=2)}</item></r>'
            f"</item></q><g><c>{value}</c>{block.format(row=3)}</g></data>"
        )

    def run(value):
        return {"end": "submitted", "trace": [{"screen": "form", "submission": submission(value)}]}

    found = compare_traces({"runs": [run("1")]}, {"runs": [run("2")]}, check="proof3", document="d", rules=())
    classes = {}
    for difference in found:
        classes.setdefault((difference.path, difference.kind), []).append(difference.at)
    data = "/runs/*/trace/*/submission/data"
    assert {key: len(ats) for key, ats in classes.items()} == {
        (f"{data}/*/text()", "changed"): 3,
        (f"{data}/*/item[@id=*]/case[*]/update[*]/*/text()", "changed"): 2,
        (f"{data}/*/case[*]/update[*]/*/text()", "changed"): 1,
    }


def test_a_case_lists_rows_are_compared_by_the_case_each_selects():
    """A list whose rows come in another order shows that once, as its order, and each row's fields and sort keys
    are compared with the same case's row, so a reorder does not surface again as every field it moved. A field
    with no sort key (``null``, which Core sorts and searches by the text it shows) reads as having none, so a key
    only one side has is added or removed, and two that differ are changed. The plausible failure: rows compared
    where they stand, so a reorder and a field that differs are one class."""

    def run(rows):
        return {"end": "submitted", "trace": [{"screen": "list", "rows": rows}]}

    before = run(
        [
            {"caseId": "a", "fields": ["Amina", "1"], "sortFields": [None, "1"]},
            {"caseId": "b", "fields": ["Baraka", "2"], "sortFields": [None, "2"]},
        ]
    )
    after = run(
        [
            {"caseId": "b", "fields": ["Baraka", "3"], "sortFields": ["baraka", "2"]},
            {"caseId": "a", "fields": ["Amina", "1"], "sortFields": [None, None]},
        ]
    )
    found = compare_traces({"runs": [before]}, {"runs": [after]}, check="proof3", document="d", rules=())
    rows = "/runs/*/trace/*/rows/*"
    assert sorted((d.path, d.at, d.kind) for d in found) == [
        (f"{rows}/caseId", "/runs/0/trace/0/rows/0/caseId", "changed"),
        (f"{rows}/caseId", "/runs/0/trace/0/rows/1/caseId", "changed"),
        (f"{rows}/fields/*", "/runs/0/trace/0/rows/b/fields/1", "changed"),
        (f"{rows}/sortFields/*", "/runs/0/trace/0/rows/a/sortFields/1", "removed"),
        (f"{rows}/sortFields/*", "/runs/0/trace/0/rows/b/sortFields/0", "added"),
    ]


REFUSED_CLASS = "org.javarosa.xml.util.InvalidStructureException"


def _refusable_run(guard_id="g", operation_id="v", refusal=None, operation_action="update"):
    """A form run whose submission holds a guard's block and an operation's (``lib/commcare/xform/caseOps.ts``),
    the operation's block an update or a create (``operation_action``), submitted, or refused by Core with
    ``refusal`` (``FormRun.java::submit`` then records neither the case database nor the stack after submit)."""
    operation = (
        "<update><s>b</s></update>"
        if operation_action == "update"
        else "<create><case_type>visit</case_type><case_name>b</case_name></create>"
    )
    submission = (
        '<data xmlns="http://openrosa.org/formdesigner/F"><q>1</q><__nova_operations>'
        f'<__nova_guard_1270f255_text><case xmlns="{CX2}" case_id="{guard_id}" date_modified="d" user_id="u">'
        "<update><s>a</s></update></case></__nova_guard_1270f255_text>"
        f'<visit><case xmlns="{CX2}" case_id="{operation_id}" date_modified="d" user_id="u">{operation}'
        "</case></visit></__nova_operations></data>"
    )
    step = {"screen": "form", "submission": submission}
    if refusal is None:
        step["caseDb"] = "<casedb>" + _case("g") + "</casedb>"
        step["stackAfterSubmit"] = {"nextFrameReady": False, "steps": [], "pendingFrames": 0}
    else:
        step["processing"] = refusal
    return {"end": "submitted" if refusal is None else "submission-refused", "trace": [{"screen": "menu"}, step]}


def _empty_id_refusal():
    """Core's refusal of a block with an empty case id, as its case parser words it
    (``CaseXmlParserUtil.validateMandatoryProperty``)."""
    message = f"The case_id attribute of a <case>  wasn't set. Source: <n0:case> tag in namespace: {CX2}"
    return {"class": REFUSED_CLASS, "message": message}


def test_cores_refusal_of_a_submission_names_its_cause_and_so_does_what_the_refusal_leaves_out():
    """Core refuses a submission at the first case block, in document order, missing a case id; the refusal names
    its exception, the attribute, the block's first action and where that block sits, so a guard's empty id and an
    operation's are two classes, and so are an operation's that opens a case and one that writes an existing case.
    What the runner records only of a processed submission (the case database, the stack after submit) and the
    run's changed end carry the same cause; a refusal for another cause is named by its exception alone."""
    guard = f"{REFUSED_CLASS}/case_id/update/__nova_operations~1__nova_guard_*~1case"
    operation = f"{REFUSED_CLASS}/case_id/update/__nova_operations~1*~1case"
    created = f"{REFUSED_CLASS}/case_id/create/__nova_operations~1*~1case"
    opening = _refusable_run(operation_id="", refusal=_empty_id_refusal(), operation_action="create")
    assert {
        key
        for key in _paths([_refusable_run(operation_action="create")], [opening])
        if key[0].startswith("/runs/*/trace/*/processing/") and key[0].count("/") == 9
    } == {(f"/runs/*/trace/*/processing/{created}", "added")}
    for lost, cause in (
        ({"guard_id": ""}, guard),
        ({"operation_id": ""}, operation),
        ({"guard_id": "", "operation_id": ""}, guard),
    ):
        refused = _refusable_run(**lost, refusal=_empty_id_refusal())
        assert {key for key in _paths([_refusable_run()], [refused]) if "/submission/" not in key[0]} == {
            (f"/runs/*/trace/*/processing/{cause}", "added"),
            (f"/runs/*/trace/*/processing/{cause}/caseDb", "removed"),
            (f"/runs/*/trace/*/processing/{cause}/stackAfterSubmit", "removed"),
            (f"/runs/*/end/submitted/submission-refused/{cause}", "changed"),
        }
    # The other side refused instead: the same classes, each of the other kind.
    assert {
        key
        for key in _paths([_refusable_run(guard_id="", refusal=_empty_id_refusal())], [_refusable_run()])
        if "/submission/" not in key[0]
    } == {
        (f"/runs/*/trace/*/processing/{guard}", "removed"),
        (f"/runs/*/trace/*/processing/{guard}/caseDb", "added"),
        (f"/runs/*/trace/*/processing/{guard}/stackAfterSubmit", "added"),
        (f"/runs/*/end/submission-refused/submitted/{guard}", "changed"),
    }
    # Both sides refused, at two blocks: two causes.
    assert {
        key
        for key in _paths(
            [_refusable_run(guard_id="", refusal=_empty_id_refusal())],
            [_refusable_run(operation_id="", refusal=_empty_id_refusal())],
        )
        if "/submission/" not in key[0]
    } == {(f"/runs/*/trace/*/processing/{guard}", "removed"), (f"/runs/*/trace/*/processing/{operation}", "added")}
    # A refusal Core raised for another cause names no block, even where a later block's case id is empty (Core
    # stops at the first block that raises): it is named by its exception and where Core made it, as an error is.
    site = "org.commcare.xml.CaseXmlParser.loadCase(CaseXmlParser.java:243)"
    other = {"class": REFUSED_CLASS, "message": "Unable to update or close case v, it wasn't found", "site": site}
    for lost in ({}, {"operation_id": ""}):
        refused = [d.path for d in _found([_refusable_run()], [_refusable_run(**lost, refusal=other)])]
        assert {path for path in refused if "/submission/" not in path} == {
            f"/runs/*/trace/*/processing/{REFUSED_CLASS}/{site}",
            f"/runs/*/trace/*/processing/{REFUSED_CLASS}/{site}/caseDb",
            f"/runs/*/trace/*/processing/{REFUSED_CLASS}/{site}/stackAfterSubmit",
            f"/runs/*/end/submitted/submission-refused/{REFUSED_CLASS}/{site}",
        }


FORM_ERROR_CLASS = "org.javarosa.xpath.XPathException"
MISMATCH_CLASS = "org.javarosa.xpath.XPathTypeMismatchException"
# Where Core makes the failures these runs raise, as the runner records it (``FormRun.java::site``): commcare-core
# ``XPathSelectedAtFunc.java::selectedAt``'s one template, and two of ``FunctionUtils.java::toDate``'s three.
SELECTED_AT = "org.javarosa.xpath.expr.XPathSelectedAtFunc.selectedAt(XPathSelectedAtFunc.java:40)"
TO_DATE_STRING = "org.javarosa.xpath.expr.FunctionUtils.toDate(FunctionUtils.java:382)"
TO_DATE_RANGE = "org.javarosa.xpath.expr.FunctionUtils.toDate(FunctionUtils.java:369)"
FORM_XMLNS = "http://openrosa.org/formdesigner/F"


def _selected_at(index, count, prefix=""):
    """Core's failure of ``selected-at`` past a list's end (``XPathSelectedAtFunc.java::selectedAt``), its message
    after the prefix a bind's evaluation gives it (``Recalculate.java::eval``, ``Condition.java::eval``)."""
    message = f"{prefix}Attempting to select element {index} of a list with only {count} elements."
    return {"class": FORM_ERROR_CLASS, "message": message, "site": SELECTED_AT}


def _to_date(value=None):
    """Core's failure converting a value to a date (``FunctionUtils.java::toDate``): a string it cannot read, or,
    with no ``value``, a number out of a date's range."""
    if value is None:
        return {"class": MISMATCH_CLASS, "message": "converting out-of-range value to date", "site": TO_DATE_RANGE}
    return {"class": MISMATCH_CLASS, "message": f"converting string {value} to date", "site": TO_DATE_STRING}


def _filled_run(events=4, error=None, answer="a"):
    """A run whose form Core filled in and submitted (``FormRun.java``: its events, its submission with a generated
    instance id, the case database and the stack after submit), or that stopped with Core raising ``error`` after
    ``events`` events (``form-error``: the events it reached, nothing after them)."""
    reached = [
        {"event": "question", "dataPath": f"/data/q{index}", "answer": answer if index == 1 else "x"}
        for index in range(events)
    ]
    step = {"screen": "form", "xmlns": FORM_XMLNS, "title": "Visit", "events": reached}
    if error is None:
        step["submission"] = (
            f'<data xmlns="{FORM_XMLNS}"><q0>x</q0><orx:meta xmlns:orx="http://openrosa.org/jr/xforms">'
            "<orx:instanceID>@generated:uuid:1</orx:instanceID></orx:meta></data>"
        )
        step["caseDb"] = "<casedb>" + _case("c") + "</casedb>"
        step["stackAfterSubmit"] = {"nextFrameReady": False, "steps": [], "pendingFrames": 0}
    else:
        step["error"] = error
    return _counted({"end": "submitted" if error is None else "form-error", "script": [], "trace": [step]})


def test_an_exception_core_raised_names_its_cause_and_so_does_what_it_left_out():
    """Core raising as a form is filled in stops the form there: the error names its exception and where Core made
    it, and what the form did not reach (the events past the last it recorded, the submission, the case database,
    the stack after submit) and the run's changed end carry the same cause, so the same failure with other values
    is one class. An event the form reached is compared as itself, and how many ids the runs generated (one, and
    none once the submission is gone) is not."""
    cause = f"{FORM_ERROR_CLASS}/{SELECTED_AT}"
    expected = {
        (f"/runs/*/trace/*/error/{cause}", "added"),
        (f"/runs/*/trace/*/error/{cause}/events/*", "removed"),
        (f"/runs/*/trace/*/error/{cause}/submission", "removed"),
        (f"/runs/*/trace/*/error/{cause}/caseDb", "removed"),
        (f"/runs/*/trace/*/error/{cause}/stackAfterSubmit", "removed"),
        (f"/runs/*/end/submitted/form-error/{cause}", "changed"),
    }
    assert _paths([_filled_run()], [_filled_run(2, _selected_at(2, 1))]) == expected
    assert _paths([_filled_run()], [_filled_run(3, _selected_at(5, 3))]) == expected
    found = _found([_filled_run()], [_filled_run(2, _selected_at(2, 1))])
    assert sorted(d.at for d in found if d.path.endswith("/events/*")) == [
        f"/runs/0/trace/0/error/{cause}/events/{index}" for index in (2, 3)
    ]
    # An event the erring form reached is that event's own difference.
    assert _paths([_filled_run()], [_filled_run(2, _selected_at(2, 1), answer="b")]) == {
        *expected,
        ("/runs/*/trace/*/events/*/answer", "changed"),
    }
    # The other side raised instead: the same classes, each of the other kind.
    assert _paths([_filled_run(2, _selected_at(2, 1))], [_filled_run()]) == {
        (f"/runs/*/trace/*/error/{cause}", "removed"),
        (f"/runs/*/trace/*/error/{cause}/events/*", "added"),
        (f"/runs/*/trace/*/error/{cause}/submission", "added"),
        (f"/runs/*/trace/*/error/{cause}/caseDb", "added"),
        (f"/runs/*/trace/*/error/{cause}/stackAfterSubmit", "added"),
        (f"/runs/*/end/form-error/submitted/{cause}", "changed"),
    }
    # A form Core could not open recorded no title and no events: both are that failure's.
    unopened_step = {"screen": "form", "xmlns": FORM_XMLNS, "error": _to_date()}
    unopened = _counted({"end": "form-did-not-open", "script": [], "trace": [unopened_step]})
    other = f"{MISMATCH_CLASS}/{TO_DATE_RANGE}"
    assert _paths([_filled_run()], [unopened]) == {
        (f"/runs/*/trace/*/error/{other}", "added"),
        *((f"/runs/*/trace/*/error/{other}/{field}", "removed") for field in ("title", "events", "submission")),
        (f"/runs/*/trace/*/error/{other}/caseDb", "removed"),
        (f"/runs/*/trace/*/error/{other}/stackAfterSubmit", "removed"),
        (f"/runs/*/end/submitted/form-did-not-open/{other}", "changed"),
    }


def test_an_exceptions_cause_is_where_core_made_it_never_what_its_message_says():
    """An exception is named by its class and the line of Core's that made it, which holds its message's
    template: one template is one class whatever values its message carries, on one document or two, and whatever
    prefix the bind that raised it gives the message; two templates of one exception class, in one method, are two.
    An exception whose stack held no frame of Core's is its class alone, and a failure the runner records as text
    is named by the end it leaves its run with, which its run's changed end names already."""
    cause = f"{FORM_ERROR_CLASS}/{SELECTED_AT}"
    calculation = _selected_at(2, 1, "Calculation Error: Error in calculation for /data/group[1]/q[2]\n")
    condition = _selected_at(7, 3, "Display Condition Error: Error in calculation for /data/other/q\n")
    assert _paths([_filled_run(2, calculation)], [_filled_run(2, condition)]) == {
        (f"/runs/*/trace/*/error/{cause}", "changed")
    }
    assert _paths([_filled_run(2, _selected_at(2, 1))], [_filled_run(2, _selected_at(2, 1))]) == set()
    string = f"{MISMATCH_CLASS}/{TO_DATE_STRING}"
    assert (
        _paths([_filled_run()], [_filled_run(1, _to_date("abc"))])
        == _paths([_filled_run()], [_filled_run(1, _to_date("tomorrow"))])
        == {
            (f"/runs/*/trace/*/error/{string}", "added"),
            *((f"/runs/*/trace/*/error/{string}/{field}", "removed") for field in ("events/*", "submission")),
            (f"/runs/*/trace/*/error/{string}/caseDb", "removed"),
            (f"/runs/*/trace/*/error/{string}/stackAfterSubmit", "removed"),
            (f"/runs/*/end/submitted/form-error/{string}", "changed"),
        }
    )
    assert _paths([_filled_run(1, _to_date("abc"))], [_filled_run(1, _to_date())]) == {
        (f"/runs/*/trace/*/error/{string}", "removed"),
        (f"/runs/*/trace/*/error/{MISMATCH_CLASS}/{TO_DATE_RANGE}", "added"),
    }
    unplaced = {"class": FORM_ERROR_CLASS, "message": "Attempting to select element 2 of a list with only 1 elements."}
    assert (f"/runs/*/trace/*/error/{FORM_ERROR_CLASS}", "added") in _paths([_filled_run()], [_filled_run(2, unplaced)])
    missing = _counted(
        {
            "end": "form-missing",
            "script": [],
            "trace": [{"screen": "form", "xmlns": FORM_XMLNS, "error": "Core has no installed form with this xmlns."}],
        }
    )
    assert _paths([_filled_run()], [missing]) == {
        ("/runs/*/trace/*/error/form-missing", "added"),
        *((f"/runs/*/trace/*/error/form-missing/{field}", "removed") for field in ("title", "events", "submission")),
        ("/runs/*/trace/*/error/form-missing/caseDb", "removed"),
        ("/runs/*/trace/*/error/form-missing/stackAfterSubmit", "removed"),
        ("/runs/*/end/submitted/form-missing", "changed"),
    }
    # Core's text for a search response it could not read is named by its end too, whatever the text says.
    unread = "Error parsing response: unexpected end of document"
    assert _paths([_search_run(unread)], [_search_run("Error parsing response: no casedb root")]) == {
        ("/runs/*/trace/*/error/search-failed", "changed")
    }
    assert _paths([_search_run()], [_search_run(unread)]) >= {
        ("/runs/*/trace/*/error/search-failed", "added"),
        ("/runs/*/end/script-ended/search-failed", "changed"),
    }


def _search_run(error=None):
    """A run that searches after its menu (``SessionOp.java::search``: the search's prompts, the answers the
    script gave, the query, Core's requests) and lists what the search found; with ``error``, Core's text for a
    response it could not read, which ends the run at the search (``search-failed``)."""
    search = {"screen": "search", "title": "Find", "prompts": [{"key": "name", "text": "Name"}]}
    search |= {"defaultSearch": False, "chosen": {"search": {"name": "a"}}, "url": "https://hq/search"}
    search |= {"params": {"case_type": ["visit"], "name": ["a"]}, "promptErrors": {}}
    search["requests"] = [{"kind": "search", "caseTypes": ["visit"], "answered": 1}]
    menu = {"screen": "menu", "root": "root", "choices": [{"command": "m0"}], "chosen": "m0"}
    if error is not None:
        search["error"] = error
        return _counted({"end": "search-failed", "script": [], "trace": [menu, search]})
    listed = {"screen": "case-list", "datum": "case_id", "detail": "m0_case_short", "title": "Visits"}
    return _counted({"end": "script-ended", "script": [], "trace": [menu, search, listed]})


def _case_list(error=None, header="Name"):
    """A run that reaches a case list after its menu (``SessionOp.java``: the list's datum, detail and title, then
    its headers, its rows and its actions, then the case the script chose) and ends there; with ``error``, Core
    raised as the runner read the list's rows, so the step holds its headers and none of what came after them."""
    step = {"screen": "case-list", "datum": "case_id", "detail": "m0_case_short", "title": "Visits"}
    step["headers"] = [header]
    if error is None:
        step["rows"] = [{"caseId": "c", "fields": ["proof"], "sortFields": [None]}]
        step["actions"] = []
        step["chosen"] = {"select": "c"}
    else:
        step["error"] = error
    menu = {"screen": "menu", "root": "root", "choices": [{"command": "m0"}], "chosen": "m0"}
    return _counted({"end": "script-ended" if error is None else "error", "script": [], "trace": [menu, step]})


def test_a_stop_on_a_step_no_form_names_what_it_left_out_by_the_screen_it_reached():
    """A stop leaves out what the runner records past it. On a screen both sides reached, that is each field the
    stopping step does not hold (the runner puts a screen's fields one after another, each whole), and a field it
    holds is compared as itself. A step the stop came before the runner recorded anything of (Core could not say
    what the session needs next) left out everything the other side's step holds, its screen too. Beside a step of
    another screen, a stop leaves out nothing: the two are different screens, whatever the stop."""
    cause = f"{MISMATCH_CLASS}/{TO_DATE_STRING}"
    assert _paths([_case_list()], [_case_list(_to_date("abc"), header="Visit")]) == {
        (f"/runs/*/trace/*/error/{cause}", "added"),
        *((f"/runs/*/trace/*/error/{cause}/{field}", "removed") for field in ("rows", "actions", "chosen")),
        ("/runs/*/trace/*/headers/*", "changed"),
        (f"/runs/*/end/script-ended/error/{cause}", "changed"),
    }
    session = _counted({"end": "error", "script": [], "trace": [{"screen": "session", "error": _to_date("abc")}]})
    assert _paths([_filled_run()], [session]) == {
        (f"/runs/*/trace/*/error/{cause}", "added"),
        (f"/runs/*/trace/*/error/{cause}/screen", "changed"),
        *(
            (f"/runs/*/trace/*/error/{cause}/{field}", "removed")
            for field in ("xmlns", "title", "events", "submission", "caseDb", "stackAfterSubmit")
        ),
        (f"/runs/*/end/submitted/error/{cause}", "changed"),
    }
    menu = _counted({"end": "script-ended", "script": [], "trace": [_case_list()["trace"][0]] * 2})
    assert _paths([menu], [_case_list(_to_date("abc"))]) == {
        (f"/runs/*/trace/*/error/{cause}", "added"),
        ("/runs/*/trace/*/screen", "changed"),
        *(("/runs/*/trace/*/" + field, "removed") for field in ("root", "choices", "chosen")),
        *(("/runs/*/trace/*/" + field, "added") for field in ("datum", "detail", "title", "headers")),
        (f"/runs/*/end/script-ended/error/{cause}", "changed"),
    }


def test_a_stop_on_a_form_leaves_out_only_what_comes_after_where_its_end_says_it_came():
    """A form's stop leaves out the fields the runner records after where it came, which its run's end names. Core
    raising after it processed a submitted form left out the stack after submit, and the case database where it
    raised before reading it (``FormRun.java::submit``'s last try block): beside a form left incomplete, its
    required questions without a value, and the submission and the case database the other side never made, are
    the forms' own differences, and beside a submitted form, a case database the erring form holds is compared as
    itself."""
    events = [{"event": "question", "dataPath": f"/data/q{index}", "answer": "x"} for index in range(2)]
    incomplete = {"screen": "form", "xmlns": FORM_XMLNS, "title": "Visit", "events": events}
    finished = {
        **incomplete,
        "submission": f'<data xmlns="{FORM_XMLNS}"><q0>x</q0></data>',
        "caseDb": "<casedb>" + _case("c") + "</casedb>",
        "error": _selected_at(1, 0),
    }
    left = _counted({"end": "incomplete", "script": [], "trace": [{**incomplete, "unansweredRequired": ["/data/q1"]}]})
    navigated = _counted({"end": "end-of-form-navigation-failed", "script": [], "trace": [finished]})
    cause = f"{FORM_ERROR_CLASS}/{SELECTED_AT}"
    assert _paths([left], [navigated]) == {
        (f"/runs/*/trace/*/error/{cause}", "added"),
        ("/runs/*/trace/*/unansweredRequired", "removed"),
        ("/runs/*/trace/*/submission", "added"),
        ("/runs/*/trace/*/caseDb", "added"),
        (f"/runs/*/end/incomplete/end-of-form-navigation-failed/{cause}", "changed"),
    }
    submitted = _filled_run(events=2, answer="x")
    ended = {
        (f"/runs/*/trace/*/error/{cause}", "added"),
        (f"/runs/*/trace/*/error/{cause}/stackAfterSubmit", "removed"),
        (f"/runs/*/end/submitted/end-of-form-navigation-failed/{cause}", "changed"),
    }
    unread = {key: value for key, value in finished.items() if key != "caseDb"}
    unread_run = _counted({"end": "end-of-form-navigation-failed", "script": [], "trace": [unread]})
    assert {key for key in _paths([submitted], [unread_run]) if "/submission/" not in key[0]} == {
        *ended,
        (f"/runs/*/trace/*/error/{cause}/caseDb", "removed"),
    }
    read = {**finished, "caseDb": "<casedb>" + _case("c", visits="2") + "</casedb>"}
    read_run = _counted({"end": "end-of-form-navigation-failed", "script": [], "trace": [read]})
    assert {key for key in _paths([submitted], [read_run]) if "/submission/" not in key[0]} == {
        *ended,
        ("/runs/*/trace/*/caseDb/casedb/case[@case_id=*]/*", "added"),
    }


def test_how_many_ids_a_run_generated_is_reported_where_the_ids_are():
    """A run holds an id the other does not (a case the saved form creates): that id is the difference, where it is
    (the block that writes it, the case database's case); how many ids each run generated is not reported again."""
    block = (
        f'<create_visit><case xmlns="{CX2}" case_id="@generated:uuid:2" date_modified="d" user_id="u">'
        "<create><case_name>proof</case_name><case_type>visit</case_type></create></case></create_visit>"
    )
    created = _filled_run()
    step = created["trace"][0]
    step["submission"] = step["submission"].replace(
        "<orx:meta", f"<__nova_operations>{block}</__nova_operations><orx:meta"
    )
    step["caseDb"] = "<casedb>" + _case("c") + _case("@generated:uuid:2", "visit") + "</casedb>"
    created = _counted(created)
    assert (_filled_run()["generated"]["uuids"], created["generated"]["uuids"]) == (1, 2)
    assert _paths([_filled_run()], [created]) == {
        ("/runs/*/trace/*/submission/data/__nova_operations[*]", "added"),
        ("/runs/*/trace/*/caseDb/casedb/case[@case_id=*]", "added"),
    }


def test_generated_ids_in_the_text_after_two_siblings_keep_two_names():
    """The text after each child is read at that child's place, so two ids after two siblings are two ids: one id
    where the other run used two still differs, and the same two ids numbered in another order do not."""

    def run(first, second):
        submission = f'<data xmlns="f"><a/>@generated:uuid:{first}<b/>@generated:uuid:{second}</data>'
        return {"end": "submitted", "trace": [{"screen": "form", "submission": submission}]}

    assert _paths([run(1, 2)], [run(2, 1)]) == set()
    assert _paths([run(1, 2)], [run(1, 1)]) == {("/runs/*/trace/*/submission/data/*/tail()", "changed")}
